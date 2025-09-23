const net = require('net');

console.log('Loading iPortSMButtons plugin');

class IPortSMButtonsPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    // network/config
    this.ip = this.config.ip || '192.168.2.12';
    this.port = this.config.port || 10001;
    this.timeout = this.config.timeout || 5000;
    this.reconnectDelay = this.config.reconnectDelay || 5000;
    this.triggerResetDelay = typeof this.config.triggerResetDelay === 'number' ? this.config.triggerResetDelay : 500; // ms

    // runtime state
    this.buttonServices = [];
    this.mappingSwitches = {}; // mappingKey -> Switch service
    this.buttonStates = Array.from({ length: 10 }, () => ({ state: 0, lastPress: 0 }));
    this.ledColor = { r: 255, g: 255, b: 255 };
    this.connected = false;
    this.socket = null;
    this.isShuttingDown = false;
    this.keepAliveInterval = null;
    this.eventQueue = [];
    this.lastRawData = null;

    // color mapping
    this.modeColors = {
      yellow: { r: 255, g: 255, b: 0 },
      red: { r: 255, g: 0, b: 0 },
      blue: { r: 0, g: 0, b: 255 },
      green: { r: 0, g: 255, b: 0 },
      purple: { r: 128, g: 0, b: 128 },
      white: { r: 255, g: 255, b: 255 }
    };

    this.colorCycle = ['red', 'green', 'blue', 'yellow', 'purple', 'white'];
    this.currentColorIndex = 0;

    this.buttonMappings = this.config.buttonMappings || [];
    this.log(`Config loaded: ${JSON.stringify(this.config)}`);

    if (!this.api || !this.api.hap) {
      this.log('Error: Homebridge API or HAP is undefined');
      return;
    }

    this.log('IPortSMButtonsPlatform initialized');

    // start connection immediately
    this.connect();

    // create/register accessories after Homebridge finishes launching
    this.api.on('didFinishLaunching', () => {
      this.log('Homebridge finished launching');
      this.accessories((accessories) => {
        this.log('Registering accessories after didFinishLaunching');
        this.api.registerPlatformAccessories('homebridge-iport-sm-buttons', 'IPortSMButtons', accessories);
      });
      this.processQueuedEvents();
    });

    // cleanup on shutdown
    this.api.on('shutdown', () => {
      this.isShuttingDown = true;
      this.log('Homebridge shutting down, closing socket');
      if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
      if (this.socket) this.socket.destroy();
    });
  }

  // -------------------------
  // Connection & parsing
  // -------------------------
  connect() {
    if (!this.ip) {
      this.log.error('No IP configured for iPort device');
      return;
    }

    this.log(`Connecting to ${this.ip}:${this.port}`);
    this.socket = new net.Socket();
    this.socket.setTimeout(this.timeout);

    this.socket.connect(this.port, this.ip, () => {
      this.log(`Connected to ${this.ip}:${this.port}`);
      this.connected = true;

      // initial LED query (we keep it, but queryLED writes silently)
      this.queryLED();

      if (this.accessory && this.accessory.updateReachability) this.accessory.updateReachability(true);

      // keep polling LED state (no verbose logging)
      this.keepAliveInterval = setInterval(() => {
        if (this.connected && !this.isShuttingDown) this.queryLED();
      }, 5000);
    });

    this.socket.on('data', (data) => {
      if (this.isShuttingDown) return;
      const str = data.toString().trim();
      this.lastRawData = str; // keep latest raw in memory for diagnostics if needed

      // try JSON first (some iPort replies are JSON)
      try {
        const json = JSON.parse(str);
        if (json.led) {
          // some devices include led in JSON
          this.parseAndSetLedFromString(String(json.led));
        }
        if (json.events) {
          json.events.forEach((event) => {
            const keyNum = parseInt(event.label.split(' ')[1], 10) - 1;
            const state = parseInt(event.state, 10);
            this.queueOrHandleEvent(keyNum, state);
          });
        }
      } catch (e) {
        // not JSON; handle 'led=' and raw RGB strings like "255255000"
        if (str.includes('led=')) {
          const ledValue = str.split('led=')[1]?.trim();
          if (ledValue) this.parseAndSetLedFromString(ledValue);
        } else {
          const possibleRGB = str.replace(/\r|\n/g, '').trim();
          if (/^\d{9}$/.test(possibleRGB)) this.parseAndSetLedFromString(possibleRGB);
          // otherwise ignore (or keep as lastRawData for debugging)
        }
      }
    });

    this.socket.on('error', (err) => {
      this.log(`Socket error: ${err.message}`);
      try { this.socket.destroy(); } catch (e) {}
      this.connected = false;
      if (this.accessory && this.accessory.updateReachability) this.accessory.updateReachability(false);
      if (!this.isShuttingDown) setTimeout(() => this.connect(), this.reconnectDelay);
    });

    this.socket.on('close', () => {
      this.log('Connection closed');
      this.connected = false;
      if (this.accessory && this.accessory.updateReachability) this.accessory.updateReachability(false);
      if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
      if (!this.isShuttingDown) setTimeout(() => this.connect(), this.reconnectDelay);
    });

    this.socket.on('timeout', () => {
      // suppress timeout log noise
      try { this.socket.destroy(); } catch (e) {}
    });
  }

  // parse 9-digit rgb string safely and set ledColor (silent updates)
  parseAndSetLedFromString(ledValue) {
    try {
      const s = String(ledValue).trim();
      const padded = s.padStart(9, '0').substr(0, 9);
      const newR = parseInt(padded.substr(0, 3), 10);
      const newG = parseInt(padded.substr(3, 3), 10);
      const newB = parseInt(padded.substr(6, 3), 10);
      this.ledColor = { r: newR, g: newG, b: newB };
      // update HomeKit characteristics silently (no repetitive logging)
      this.updateLightCharacteristics();
    } catch (err) {
      // ignore parse errors
    }
  }

  // -------------------------
  // Event queue / button handling
  // -------------------------
  queueOrHandleEvent(buttonIndex, state) {
    // minimal logging — useful to know events are queued/handled
    this.log(`Queue or handle event: button ${buttonIndex + 1}, state ${state}, services ${this.buttonServices.length}`);
    if (this.buttonServices.length === 0) {
      this.eventQueue.push({ buttonIndex, state });
      this.log(`Queued event for button ${buttonIndex + 1}, state ${state}`);
    } else {
      this.handleButtonEvent(buttonIndex, state);
    }
  }

  processQueuedEvents() {
    this.log(`Processing ${this.eventQueue.length} queued events`);
    while (this.eventQueue.length > 0) {
      const event = this.eventQueue.shift();
      this.handleButtonEvent(event.buttonIndex, event.state);
    }
  }

  handleButtonEvent(buttonIndex, state) {
    if (!this.connected || this.isShuttingDown) {
      this.log(`Cannot handle event for button ${buttonIndex + 1}: not connected or shutting down`);
      return;
    }
    const service = this.buttonServices[buttonIndex];
    if (!service) {
      this.log(`No service found for button ${buttonIndex + 1}`);
      return;
    }
    const bs = this.buttonStates[buttonIndex];

    if (state === 1) {
      bs.state = 1;
      bs.lastPress = Date.now();
    } else if (state === 0 && bs.state === 1) {
      bs.state = 0;
      this.triggerButtonEvent(buttonIndex, 0);
    }
  }

  triggerButtonEvent(buttonIndex, eventType) {
    if (this.isShuttingDown) return;
    const service = this.buttonServices[buttonIndex];
    if (service) {
      try {
        service.updateCharacteristic(this.api.hap.Characteristic.ProgrammableSwitchEvent, eventType);
      } catch (e) {
        // ignore update errors
      }
    }
    const humanType = eventType === 0 ? 'single' : eventType === 1 ? 'double' : 'long';
    this.log(`Button ${buttonIndex + 1} triggered ${humanType} press`);
    if (eventType === 0) {
      this.executeButtonAction(buttonIndex + 1);
    }
  }

  // -------------------------
  // Actions execution
  // -------------------------
  executeButtonAction(buttonNumber) {
    if (buttonNumber === 10) {
      this.cycleLEDColor();
      return;
    }

    const actions = this.buttonMappings.filter(action => action.buttonNumber === buttonNumber);
    if (actions.length === 0) {
      this.log(`No actions configured for button ${buttonNumber}`);
      return;
    }

    const currentMode = this.getCurrentMode();
    this.log(`Current LED mode: ${currentMode}`);

    let actionToExecute = actions.find(a => a.modeColor === currentMode);

    if (!actionToExecute) {
      actionToExecute = actions.find(a => a.modeColor === 'any');
      if (!actionToExecute) {
        this.log(`No action found for button ${buttonNumber} in ${currentMode} mode`);
        return;
      }
    }

    this.log(`Executing action for button ${buttonNumber}: ${JSON.stringify(actionToExecute)}`);

    // trigger the virtual mapping switch if present (preferred flow)
    const mappingKey = this.getMappingKey(actionToExecute);
    const vSwitch = this.mappingSwitches[mappingKey];
    if (vSwitch) {
      this.triggerVirtualSwitch(vSwitch, mappingKey, actionToExecute);
      return; // do not execute direct control when mapping switch exists
    }

    // fallback legacy behavior (best-effort direct control)
    if (actionToExecute.actionType === 'scene') {
      this.log(`Scene action requested: ${actionToExecute.targetName}`);
    } else if (actionToExecute.actionType === 'led') {
      this.executeLedAction(actionToExecute);
    } else {
      this.executeHomeKitAction(actionToExecute);
    }
  }

  triggerVirtualSwitch(service, mappingKey, mapping) {
    try {
      service.updateCharacteristic(this.api.hap.Characteristic.On, true);
      this.log(`Triggered virtual switch for mapping ${mappingKey} -> ${mapping.targetName || ''} : ${mapping.action}`);
      setTimeout(() => {
        try {
          service.updateCharacteristic(this.api.hap.Characteristic.On, false);
        } catch (e) {
          // ignore
        }
      }, this.triggerResetDelay);
    } catch (e) {
      this.log(`Error triggering virtual switch ${mappingKey}: ${e.message}`);
    }
  }

  getMappingKey(mapping) {
    return `btn${mapping.buttonNumber}-${mapping.modeColor}-${mapping.action}-${(mapping.targetName || '').replace(/\s+/g, '_')}`;
  }

  // -------------------------
  // LED / color helpers
  // -------------------------
  cycleLEDColor() {
    this.currentColorIndex = (this.currentColorIndex + 1) % this.colorCycle.length;
    const colorName = this.colorCycle[this.currentColorIndex];
    const color = this.modeColors[colorName];
    this.log(`Button 10 pressed: Cycling to ${colorName} color (${color.r},${color.g},${color.b})`);
    this.setLED(color.r, color.g, color.b);
  }

  getCurrentMode() {
    let { r, g, b } = this.ledColor;
    if (r === 0 && g === 0 && b === 0) return 'off';
    const max = Math.max(r, g, b);
    r = Math.round((r / max) * 255);
    g = Math.round((g / max) * 255);
    b = Math.round((b / max) * 255);

    for (const mode in this.modeColors) {
      const modeColor = this.modeColors[mode];
      if (r === modeColor.r && g === modeColor.g && b === modeColor.b) return mode;
    }
    return 'unknown';
  }

  executeLedAction(action) {
    if (action.ledColor) {
      const colorName = action.ledColor.toLowerCase();
      if (this.modeColors[colorName]) {
        const color = this.modeColors[colorName];
        this.setLED(color.r, color.g, color.b);
        this.log(`Set LED to ${colorName}`);
      } else {
        this.log(`Unknown color name: ${action.ledColor}`);
      }
    }
  }

  // -------------------------
  // HomeKit control helpers
  // -------------------------
  executeHomeKitAction(action) {
    if (!action.targetName) {
      this.log('No accessory specified for action');
      return;
    }

    const targetAccessory = this.findAccessoryByName(action.targetName);

    if (!targetAccessory) {
      this.log(`Accessory "${action.targetName}" not found in Homebridge`);
      return;
    }

    let service = targetAccessory.getService(this.api.hap.Service.Switch) || targetAccessory.getService(this.api.hap.Service.Lightbulb);

    if (!service) {
      this.log(`No Switch or Lightbulb service found on accessory "${action.targetName}"`);
      return;
    }

    const onCharacteristic = service.getCharacteristic(this.api.hap.Characteristic.On);
    if (!onCharacteristic) {
      this.log(`No On characteristic found on accessory "${action.targetName}"`);
      return;
    }

    switch (action.action) {
      case 'toggle': {
        const currentState = onCharacteristic.value;
        try { onCharacteristic.setValue(!currentState); } catch (e) {}
        this.log(`Toggled ${action.targetName} to ${!currentState ? 'on' : 'off'}`);
        break;
      }
      case 'on':
        try { onCharacteristic.setValue(true); } catch (e) {}
        this.log(`Turned on ${action.targetName}`);
        break;
      case 'off':
        try { onCharacteristic.setValue(false); } catch (e) {}
        this.log(`Turned off ${action.targetName}`);
        break;
      default:
        this.log(`Unknown action: ${action.action}`);
    }
  }

  findAccessoryByName(name) {
    try {
      // homebridge internals expose accessories in different places on different versions
      const hbServer = this.api._homebridge || this.api.server;
      if (!hbServer || !hbServer.accessories || !hbServer.accessories.accessories) {
        // cannot access internal accessory list
        return null;
      }
      const accessoriesMap = hbServer.accessories.accessories;
      for (const acc of accessoriesMap.values()) {
        if (acc.displayName === name) return acc;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  // -------------------------
  // iPort LED commands
  // -------------------------
  setLED(r, g, b) {
    if (!this.connected || this.isShuttingDown) return;
    const cmd = `\rled=${r.toString().padStart(3, '0')}${g.toString().padStart(3, '0')}${b.toString().padStart(3, '0')}\r`;
    try {
      this.socket.write(cmd);
      this.ledColor = { r, g, b };
    } catch (e) {
      // ignore write errors
    }
  }

  queryLED() {
    if (!this.connected || this.isShuttingDown) return;
    try {
      this.socket.write('\rled=?\r'); // silent query
    } catch (e) {
      // ignore
    }
  }

  // update HomeKit light characteristics silently
  updateLightCharacteristics() {
    if (!this.lightService || !this.connected || this.isShuttingDown) return;
    const hsv = this.rgbToHsv(this.ledColor.r, this.ledColor.g, this.ledColor.b);
    try {
      this.lightService
        .updateCharacteristic(this.api.hap.Characteristic.On, hsv.v > 0)
        .updateCharacteristic(this.api.hap.Characteristic.Hue, hsv.h)
        .updateCharacteristic(this.api.hap.Characteristic.Saturation, hsv.s)
        .updateCharacteristic(this.api.hap.Characteristic.Brightness, hsv.v);
    } catch (e) {
      // ignore characteristic update errors
    }
  }

  // -------------------------
  // Color math helpers
  // -------------------------
  rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), v = max, d = max - min;
    const s = max === 0 ? 0 : d / max;
    let h;
    if (max === min) h = 0;
    else {
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }
    return { h: h * 360, s: s * 100, v: v * 100 };
  }

  hsvToRgb(h, s, v) {
    h /= 360; s /= 100; v /= 100;
    const i = Math.floor(h * 6), f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    let r, g, b;
    switch (i % 6) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      case 5: r = v; g = p; b = q; break;
    }
    return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
  }

  // -------------------------
  // Accessories creation
  // -------------------------
  accessories(callback) {
    this.log('Starting accessories setup');
    try {
      const PlatformAccessory = this.api.platformAccessory;
      if (!PlatformAccessory) {
        throw new Error('PlatformAccessory is not available from API (api.platformAccessory is undefined)');
      }

      if (!this.api.hap.Service || !this.api.hap.Characteristic || !this.api.hap.uuid) {
        throw new Error(`Required HAP classes are undefined`);
      }

      const uuidStr = this.api.hap.uuid.generate(this.config.name || 'iPort SM Buttons');
      this.accessory = new PlatformAccessory(this.config.name || 'iPort SM Buttons', uuidStr);

      // ServiceLabel (optional)
      if (this.api.hap.Service.ServiceLabel) {
        this.accessory.addService(this.api.hap.Service.ServiceLabel)
          .setCharacteristic(this.api.hap.Characteristic.ServiceLabelNamespace, 1);
      }

      // --- 10 physical stateless button services ---
      this.buttonServices = [];
      for (let i = 1; i <= 10; i++) {
        const buttonService = this.accessory.addService(this.api.hap.Service.StatelessProgrammableSwitch, `Button ${i}`, `button${i}`);
        if (this.api.hap.Characteristic.ServiceLabelIndex) {
          buttonService.setCharacteristic(this.api.hap.Characteristic.ServiceLabelIndex, i);
        }
        this.buttonServices[i - 1] = buttonService;
        this.log(`Added button service for Button ${i}`);
      }

      // --- LED Light service ---
      this.lightService = this.accessory.addService(this.api.hap.Service.Lightbulb, 'LED');
      this.lightService.setCharacteristic(this.api.hap.Characteristic.On, true);
      this.log('Added LED light service');

      // On / Brightness / Hue / Saturation handlers (kept as before)
      this.lightService.getCharacteristic(this.api.hap.Characteristic.On)
        .onGet(() => {
          if (!this.connected) throw new Error('Device not connected');
          return this.rgbToHsv(this.ledColor.r, this.ledColor.g, this.ledColor.b).v > 0;
        })
        .onSet((value) => {
          if (!this.connected) throw new Error('Device not connected');
          if (value && this.ledColor.r === 0 && this.ledColor.g === 0 && this.ledColor.b === 0) {
            this.setLED(255, 255, 255);
          } else if (!value) {
            this.setLED(0, 0, 0);
          }
        });

      this.lightService.getCharacteristic(this.api.hap.Characteristic.Brightness)
        .onGet(() => {
          if (!this.connected) throw new Error('Device not connected');
          return this.rgbToHsv(this.ledColor.r, this.ledColor.g, this.ledColor.b).v;
        })
        .onSet((value) => {
          if (!this.connected) throw new Error('Device not connected');
          const h = this.lightService.getCharacteristic(this.api.hap.Characteristic.Hue).value;
          const s = this.lightService.getCharacteristic(this.api.hap.Characteristic.Saturation).value;
          const { r, g, b } = this.hsvToRgb(h, s, value);
          this.setLED(r, g, b);
        });

      this.lightService.getCharacteristic(this.api.hap.Characteristic.Hue)
        .onGet(() => {
          if (!this.connected) throw new Error('Device not connected');
          return this.rgbToHsv(this.ledColor.r, this.ledColor.g, this.ledColor.b).h;
        })
        .onSet((value) => {
          if (!this.connected) throw new Error('Device not connected');
          const s = this.lightService.getCharacteristic(this.api.hap.Characteristic.Saturation).value;
          const v = this.lightService.getCharacteristic(this.api.hap.Characteristic.Brightness).value;
          const { r, g, b } = this.hsvToRgb(value, s, v);
          this.setLED(r, g, b);
        });

      this.lightService.getCharacteristic(this.api.hap.Characteristic.Saturation)
        .onGet(() => {
          if (!this.connected) throw new Error('Device not connected');
          return this.rgbToHsv(this.ledColor.r, this.ledColor.g, this.ledColor.b).s;
        })
        .onSet((value) => {
          if (!this.connected) throw new Error('Device not connected');
          const h = this.lightService.getCharacteristic(this.api.hap.Characteristic.Hue).value;
          const v = this.lightService.getCharacteristic(this.api.hap.Characteristic.Brightness).value;
          const { r, g, b } = this.hsvToRgb(h, value, v);
          this.setLED(r, g, b);
        });

      // --- Virtual mapping Switches (one per mapping) ---
      this.mappingSwitches = {};
      this.buttonMappings.forEach((mapping) => {
        const key = this.getMappingKey(mapping);
        const svcName = `B${mapping.buttonNumber} [${mapping.modeColor}] → ${mapping.action} ${mapping.targetName || ''}`;
        const vSwitch = this.accessory.addService(this.api.hap.Service.Switch, svcName, key);

        // Auto-reset if user toggles in UI
        vSwitch.getCharacteristic(this.api.hap.Characteristic.On).onSet((value) => {
          if (value) {
            setTimeout(() => {
              try { vSwitch.updateCharacteristic(this.api.hap.Characteristic.On, false); } catch (e) {}
            }, this.triggerResetDelay);
          }
        });

        // store by subtype (mapping key)
        this.mappingSwitches[key] = vSwitch;
        this.log(`Added mapping switch: ${svcName}`);
      });

      if (this.accessory.updateReachability) this.accessory.updateReachability(this.connected);
      this.log('Accessories setup completed');
      this.processQueuedEvents();
      callback([this.accessory]);
    } catch (e) {
      this.log(`Error in accessories setup: ${e.message}`);
      callback([]);
    }
  }

  // restore cached accessory on startup
  configureAccessory(accessory) {
    this.log('Configuring cached accessory');
    try {
      this.accessory = accessory;
      if (this.accessory.updateReachability) this.accessory.updateReachability(this.connected);

      this.buttonServices = [];
      this.mappingSwitches = {};

      accessory.services.forEach(service => {
        // physical buttons subtypes should be 'buttonX'
        if (service.subtype?.startsWith('button')) {
          const index = parseInt(service.subtype.replace('button', '')) - 1;
          this.buttonServices[index] = service;
        } else if (service.displayName === 'LED' && service.UUID === this.api.hap.Service.Lightbulb.UUID) {
          this.lightService = service;
        } else if (service.UUID === this.api.hap.Service.Switch.UUID && service.subtype) {
          // mapping virtual switches use subtype = mappingKey
          this.mappingSwitches[service.subtype] = service;
          // ensure they are off initially
          try { service.updateCharacteristic(this.api.hap.Characteristic.On, false); } catch (e) {}
        }
      });

      this.log(`Restored ${this.buttonServices.length} button services and ${Object.keys(this.mappingSwitches).length} mapping switches`);
      this.processQueuedEvents();
    } catch (e) {
      this.log(`Error in configureAccessory: ${e.message}`);
    }
  }
}

// register platform
module.exports = (api) => {
  console.log('Registering IPortSMButtons platform');
  api.registerPlatform('homebridge-iport-sm-buttons', 'IPortSMButtons', IPortSMButtonsPlatform);
};
