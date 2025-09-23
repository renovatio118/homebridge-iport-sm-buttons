const net = require('net');
const http = require('http');
const https = require('https');

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
    this.triggerResetDelay = typeof this.config.triggerResetDelay === 'number' ? this.config.triggerResetDelay : 500;

    // runtime state
    this.buttonServices = [];
    this.mappingSwitches = {};
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
      purple: { r: 255, g: 0, b: 255 }, // fixed to full brightness
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
      this.queryLED();
      if (this.accessory && this.accessory.updateReachability) this.accessory.updateReachability(true);
      this.keepAliveInterval = setInterval(() => {
        if (this.connected && !this.isShuttingDown) this.queryLED();
      }, 5000);
    });

    this.socket.on('data', (data) => {
      if (this.isShuttingDown) return;
      const str = data.toString().trim();
      this.lastRawData = str;

      try {
        const json = JSON.parse(str);
        if (json.led) this.parseAndSetLedFromString(String(json.led));
        if (json.events) {
          json.events.forEach((event) => {
            const keyNum = parseInt(event.label.split(' ')[1], 10) - 1;
            const state = parseInt(event.state, 10);
            this.queueOrHandleEvent(keyNum, state);
          });
        }
      } catch (e) {
        if (str.includes('led=')) {
          const ledValue = str.split('led=')[1]?.trim();
          if (ledValue) this.parseAndSetLedFromString(ledValue);
        } else {
          const possibleRGB = str.replace(/\r|\n/g, '').trim();
          if (/^\d{9}$/.test(possibleRGB)) this.parseAndSetLedFromString(possibleRGB);
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
      try { this.socket.destroy(); } catch (e) {}
    });
  }

  parseAndSetLedFromString(ledValue) {
    try {
      const s = String(ledValue).trim();
      const padded = s.padStart(9, '0').substr(0, 9);
      const newR = parseInt(padded.substr(0, 3), 10);
      const newG = parseInt(padded.substr(3, 3), 10);
      const newB = parseInt(padded.substr(6, 3), 10);
      this.ledColor = { r: newR, g: newG, b: newB };
      this.updateLightCharacteristics();
    } catch (err) {}
  }

  // -------------------------
  // Event queue / button handling
  // -------------------------
  queueOrHandleEvent(buttonIndex, state) {
    if (this.buttonServices.length === 0) {
      this.eventQueue.push({ buttonIndex, state });
    } else {
      this.handleButtonEvent(buttonIndex, state);
    }
  }

  processQueuedEvents() {
    while (this.eventQueue.length > 0) {
      const event = this.eventQueue.shift();
      this.handleButtonEvent(event.buttonIndex, event.state);
    }
  }

  handleButtonEvent(buttonIndex, state) {
    if (!this.connected || this.isShuttingDown) return;
    const service = this.buttonServices[buttonIndex];
    if (!service) return;
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
      } catch (e) {}
    }
    if (eventType === 0) this.executeButtonAction(buttonIndex + 1);
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
    if (actions.length === 0) return;

    const currentMode = this.getCurrentMode();
    let actionToExecute = actions.find(a => a.modeColor === currentMode);
    if (!actionToExecute) actionToExecute = actions.find(a => a.modeColor === 'any');
    if (!actionToExecute) return;

    const mappingKey = this.getMappingKey(actionToExecute);
    const vSwitch = this.mappingSwitches[mappingKey];
    if (vSwitch) {
      this.triggerVirtualSwitch(vSwitch, mappingKey, actionToExecute);
      return;
    }

    if (actionToExecute.actionType === 'url') {
      this.executeUrlAction(actionToExecute);
    } else {
      this.executeHomeKitAction(actionToExecute);
    }
  }

  triggerVirtualSwitch(service, mappingKey, mapping) {
    try {
      service.updateCharacteristic(this.api.hap.Characteristic.On, true);
      setTimeout(() => {
        try { service.updateCharacteristic(this.api.hap.Characteristic.On, false); } catch (e) {}
      }, this.triggerResetDelay);
    } catch (e) {}
  }

  getMappingKey(mapping) {
    return `btn${mapping.buttonNumber}-${mapping.modeColor}-${mapping.action}-${(mapping.targetName || '').replace(/\s+/g, '_')}`;
  }

  executeUrlAction(action) {
    if (!action.url) {
      this.log('No URL specified for url action');
      return;
    }
    try {
      const lib = action.url.startsWith('https') ? https : http;
      const method = (action.method || 'GET').toUpperCase();
      const options = new URL(action.url);
      options.method = method;

      const req = lib.request(options, (res) => {
        res.on('data', () => {});
      });

      req.on('error', (err) => this.log(`URL action error: ${err.message}`));

      if (method === 'POST' && action.body) {
        try {
          req.write(action.body);
        } catch (e) {
          this.log(`Error writing POST body: ${e.message}`);
        }
      }
      req.end();
      this.log(`Triggered URL: ${action.url} [${method}]`);
    } catch (err) {
      this.log(`Error executing URL action: ${err.message}`);
    }
  }

  // -------------------------
  // LED / color helpers
  // -------------------------
  cycleLEDColor() {
    this.currentColorIndex = (this.currentColorIndex + 1) % this.colorCycle.length;
    const colorName = this.colorCycle[this.currentColorIndex];
    const color = this.modeColors[colorName];
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
      const mc = this.modeColors[mode];
      if (r === mc.r && g === mc.g && b === mc.b) return mode;
    }
    return 'unknown';
  }

  // -------------------------
  // HomeKit control helpers
  // -------------------------
  executeHomeKitAction(action) {
    if (!action.targetName) return;
    const targetAccessory = this.findAccessoryByName(action.targetName);
    if (!targetAccessory) return;

    let service = targetAccessory.getService(this.api.hap.Service.Switch) || targetAccessory.getService(this.api.hap.Service.Lightbulb);
    if (!service) return;
    const onCharacteristic = service.getCharacteristic(this.api.hap.Characteristic.On);
    if (!onCharacteristic) return;

    switch (action.action) {
      case 'toggle': {
        const currentState = onCharacteristic.value;
        try { onCharacteristic.setValue(!currentState); } catch (e) {}
        break;
      }
      case 'on':
        try { onCharacteristic.setValue(true); } catch (e) {}
        break;
      case 'off':
        try { onCharacteristic.setValue(false); } catch (e) {}
        break;
    }
  }

  findAccessoryByName(name) {
    try {
      const hbServer = this.api._homebridge || this.api.server;
      if (!hbServer || !hbServer.accessories || !hbServer.accessories.accessories) return null;
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
    } catch (e) {}
  }

  queryLED() {
    if (!this.connected || this.isShuttingDown) return;
    try {
      this.socket.write('\rled=?\r');
    } catch (e) {}
  }

  updateLightCharacteristics() {
    if (!this.lightService || !this.connected || this.isShuttingDown) return;
    const hsv = this.rgbToHsv(this.ledColor.r, this.ledColor.g, this.ledColor.b);
    try {
      this.lightService
        .updateCharacteristic(this.api.hap.Characteristic.On, hsv.v > 0)
        .updateCharacteristic(this.api.hap.Characteristic.Hue, hsv.h)
        .updateCharacteristic(this.api.hap.Characteristic.Saturation, hsv.s)
        .updateCharacteristic(this.api.hap.Characteristic.Brightness, hsv.v);
    } catch (e) {}
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
    try {
      const PlatformAccessory = this.api.platformAccessory;
      const uuidStr = this.api.hap.uuid.generate(this.config.name || 'iPort SM Buttons');
      this.accessory = new PlatformAccessory(this.config.name || 'iPort SM Buttons', uuidStr);

      if (this.api.hap.Service.ServiceLabel) {
        this.accessory.addService(this.api.hap.Service.ServiceLabel)
          .setCharacteristic(this.api.hap.Characteristic.ServiceLabelNamespace, 1);
      }

      this.buttonServices = [];
      for (let i = 1; i <= 10; i++) {
        const buttonService = this.accessory.addService(this.api.hap.Service.StatelessProgrammableSwitch, `Button ${i}`, `button${i}`);
        if (this.api.hap.Characteristic.ServiceLabelIndex) {
          buttonService.setCharacteristic(this.api.hap.Characteristic.ServiceLabelIndex, i);
        }
        this.buttonServices[i - 1] = buttonService;
      }

      this.lightService = this.accessory.addService(this.api.hap.Service.Lightbulb, 'LED');
      this.lightService.setCharacteristic(this.api.hap.Characteristic.On, true);

      this.mappingSwitches = {};
      this.buttonMappings.forEach((mapping) => {
        const key = this.getMappingKey(mapping);
        const svcName = `B${mapping.buttonNumber} [${mapping.modeColor}] → ${mapping.actionType}`;
        const vSwitch = this.accessory.addService(this.api.hap.Service.Switch, svcName, key);
        vSwitch.setCharacteristic(this.api.hap.Characteristic.Name, svcName);
        vSwitch.getCharacteristic(this.api.hap.Characteristic.On).onSet((value) => {
          if (value) {
            setTimeout(() => {
              try { vSwitch.updateCharacteristic(this.api.hap.Characteristic.On, false); } catch (e) {}
            }, this.triggerResetDelay);
          }
        });
        this.mappingSwitches[key] = vSwitch;
      });

      if (this.accessory.updateReachability) this.accessory.updateReachability(this.connected);
      callback([this.accessory]);
    } catch (e) {
      this.log(`Error in accessories setup: ${e.message}`);
      callback([]);
    }
  }

  configureAccessory(accessory) {
    this.accessory = accessory;
    if (this.accessory.updateReachability) this.accessory.updateReachability(this.connected);
    this.buttonServices = [];
    this.mappingSwitches = {};

    accessory.services.forEach(service => {
      if (service.subtype?.startsWith('button')) {
        const index = parseInt(service.subtype.replace('button', '')) - 1;
        this.buttonServices[index] = service;
      } else if (service.displayName === 'LED' && service.UUID === this.api.hap.Service.Lightbulb.UUID) {
        this.lightService = service;
      } else if (service.UUID === this.api.hap.Service.Switch.UUID) {
        if (service.subtype) {
          this.mappingSwitches[service.subtype] = service;
          try { service.updateCharacteristic(this.api.hap.Characteristic.On, false); } catch (e) {}
        }
      }
    });
    this.processQueuedEvents();
  }
}

module.exports = (api) => {
  console.log('Registering IPortSMButtons platform');
  api.registerPlatform('homebridge-iport-sm-buttons', 'IPortSMButtons', IPortSMButtonsPlatform);
};
