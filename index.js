const net = require('net');
const { Service, Characteristic, PlatformAccessory, uuid } = require('hap-nodejs');

console.log('Loading iPortSMButtons plugin');

class IPortSMButtonsPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.ip = this.config.ip || '192.168.2.12';
    this.port = this.config.port || 10001;
    this.timeout = this.config.timeout || 5000;
    this.reconnectDelay = this.config.reconnectDelay || 5000;
    this.buttonServices = [];
    this.buttonStates = Array.from({ length: 10 }, () => ({ state: 0, lastPress: 0 }));
    this.ledColor = { r: 255, g: 255, b: 255 };
    this.connected = false;
    this.socket = null;
    this.isShuttingDown = false;
    this.keepAliveInterval = null;
    this.eventQueue = [];
    this.lastLoggedColor = null;
    this.lastRawData = null;

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

    this.log('IPortSMButtonsPlatform initialized');

    // Force accessory registration
    this.accessories((accessories) => {
      this.log('Registering accessories on startup');
      this.api.registerPlatformAccessories('homebridge-iport-sm-buttons', 'IPortSMButtons', accessories);
    });

    this.connect();

    this.api.on('didFinishLaunching', () => {
      this.log('Homebridge finished launching');
      this.processQueuedEvents();
    });

    this.api.on('shutdown', () => {
      this.isShuttingDown = true;
      this.log('Homebridge shutting down, closing socket');
      if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
      if (this.socket) this.socket.destroy();
    });
  }

  connect() {
    this.log(`Connecting to ${this.ip}:${this.port}`);
    this.socket = new net.Socket();
    this.socket.setTimeout(this.timeout);

    this.socket.connect(this.port, this.ip, () => {
      this.log(`Connected to ${this.ip}:${this.port}`);
      this.connected = true;
      this.queryLED();
      if (this.accessory) this.accessory.updateReachability(true);
      this.keepAliveInterval = setInterval(() => {
        if (this.connected && !this.isShuttingDown) this.queryLED();
      }, 5000);
    });

    this.socket.on('data', (data) => {
      if (this.isShuttingDown) return;
      const str = data.toString().trim();
      if (this.lastRawData !== str) {
        this.log(`Received raw: ${str}`);
        this.lastRawData = str;
      }

      try {
        const json = JSON.parse(str);
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
          if (ledValue) {
            try {
              const newR = parseInt(ledValue.substr(0, 3));
              const newG = parseInt(ledValue.substr(3, 3));
              const newB = parseInt(ledValue.substr(6, 3));
              const newColor = `${newR},${newG},${newB}`;
              if (this.lastLoggedColor !== newColor) {
                this.log(`LED color updated: ${newColor}`);
                this.lastLoggedColor = newColor;
              }
              this.ledColor = { r: newR, g: newG, b: newB };
              this.updateLightCharacteristics();
            } catch (e) {
              this.log(`LED parse error: ${e.message}`);
            }
          }
        }
      }
    });

    this.socket.on('error', (err) => {
      this.log(`Socket error: ${err.message}`);
      this.socket.destroy();
      this.connected = false;
      if (this.accessory) this.accessory.updateReachability(false);
      if (!this.isShuttingDown) setTimeout(() => this.connect(), this.reconnectDelay);
    });

    this.socket.on('close', () => {
      this.log('Connection closed');
      this.connected = false;
      if (this.accessory) this.accessory.updateReachability(false);
      if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
      if (!this.isShuttingDown) setTimeout(() => this.connect(), this.reconnectDelay);
    });

    this.socket.on('timeout', () => {
      this.log('Connection timeout');
      this.socket.destroy();
    });
  }

  queueOrHandleEvent(buttonIndex, state) {
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
    if (!service) {
      this.log(`Cannot trigger event for button ${buttonIndex + 1}: no service`);
      return;
    }
    service.updateCharacteristic(Characteristic.ProgrammableSwitchEvent, eventType);
    this.log(`Button ${buttonIndex + 1} triggered ${eventType === 0 ? 'single' : eventType === 1 ? 'double' : 'long'} press`);

    if (eventType === 0) {
      this.executeButtonAction(buttonIndex + 1);
    }
  }

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
    let actionToExecute = actions.find(action => action.modeColor === currentMode);

    if (!actionToExecute) {
      actionToExecute = actions.find(action => action.modeColor === 'any');
      if (!actionToExecute) {
        this.log(`No action found for button ${buttonNumber} in ${currentMode} mode`);
        return;
      }
    }

    this.log(`Executing action for button ${buttonNumber}: ${JSON.stringify(actionToExecute)}`);

    if (actionToExecute.actionType === 'scene') {
      this.log(`Scene action requested: ${actionToExecute.targetName}`);
    } else if (actionToExecute.actionType === 'led') {
      this.executeLedAction(actionToExecute);
    } else {
      this.executeHomeKitAction(actionToExecute);
    }
  }

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

    let service = targetAccessory.getService(Service.Switch) || targetAccessory.getService(Service.Lightbulb);

    if (!service) {
      this.log(`No Switch or Lightbulb service found on accessory "${action.targetName}"`);
      return;
    }

    const onCharacteristic = service.getCharacteristic(Characteristic.On);
    if (!onCharacteristic) {
      this.log(`No On characteristic found on accessory "${action.targetName}"`);
      return;
    }

    switch (action.action) {
      case 'toggle':
        const currentState = onCharacteristic.value;
        onCharacteristic.setValue(!currentState);
        this.log(`Toggled ${action.targetName} to ${!currentState ? 'on' : 'off'}`);
        break;
      case 'on':
        onCharacteristic.setValue(true);
        this.log(`Turned on ${action.targetName}`);
        break;
      case 'off':
        onCharacteristic.setValue(false);
        this.log(`Turned off ${action.targetName}`);
        break;
      default:
        this.log(`Unknown action: ${action.action}`);
    }
  }

  findAccessoryByName(name) {
    try {
      const hbServer = this.api._homebridge || this.api.server;
      if (!hbServer || !hbServer.accessories || !hbServer.accessories.accessories) {
        this.log('Unable to access global accessories list');
        return null;
      }
      const accessoriesMap = hbServer.accessories.accessories;
      const accessoryNames = Array.from(accessoriesMap.values()).map(acc => acc.displayName);
      this.log(`Available accessories: ${JSON.stringify(accessoryNames)}`);
      for (const acc of accessoriesMap.values()) {
        if (acc.displayName === name) {
          this.log(`Found accessory: ${name}`);
          return acc;
        }
      }
      this.log(`Accessory "${name}" not found in Homebridge`);
      return null;
    } catch (e) {
      this.log(`Error in findAccessoryByName: ${e.message}`);
      return null;
    }
  }

  setLED(r, g, b) {
    if (!this.connected || this.isShuttingDown) {
      this.log(`Cannot set LED (${r},${g},${b}): Not connected or shutting down`);
      return;
    }
    const cmd = `\rled=${r.toString().padStart(3, '0')}${g.toString().padStart(3, '0')}${b.toString().padStart(3, '0')}\r`;
    this.log(`Sending LED command: ${cmd}`);
    try {
      this.socket.write(cmd);
      this.ledColor = { r, g, b };
      this.log(`Set LED to ${r},${g},${b}`);
    } catch (e) {
      this.log(`Error sending LED command: ${e.message}`);
    }
  }

  queryLED() {
    if (!this.connected || this.isShuttingDown) {
      this.log('Cannot query LED: not connected or shutting down');
      return;
    }
    const cmd = '\rled=?\r';
    this.log(`Querying LED state: ${cmd}`);
    try {
      this.socket.write(cmd);
    } catch (e) {
      this.log(`Error querying LED: ${e.message}`);
    }
  }

  updateLightCharacteristics() {
    if (!this.lightService || !this.connected || this.isShuttingDown) {
      this.log('Cannot update light characteristics: no service or not connected');
      return;
    }
    const hsv = this.rgbToHsv(this.ledColor.r, this.ledColor.g, this.ledColor.b);
    this.lightService
      .updateCharacteristic(Characteristic.On, hsv.v > 0)
      .updateCharacteristic(Characteristic.Hue, hsv.h)
      .updateCharacteristic(Characteristic.Saturation, hsv.s)
      .updateCharacteristic(Characteristic.Brightness, hsv.v);
    this.log(`Updated light characteristics: On=${hsv.v > 0}, Hue=${hsv.h}, Sat=${hsv.s}, Bri=${hsv.v}`);
  }

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

  accessories(callback) {
    this.log('Starting accessories setup');
    try {
      const uuidStr = uuid.generate(this.config.name || 'iPort SM Buttons');
      this.log(`Generated UUID: ${uuidStr}`);
      this.accessory = new PlatformAccessory(this.config.name || 'iPort SM Buttons', uuidStr);

      this.accessory.addService(Service.ServiceLabel)
        .setCharacteristic(Characteristic.ServiceLabelNamespace, 1);
      this.log('Added ServiceLabel');

      this.buttonServices = [];
      for (let i = 1; i <= 10; i++) {
        const buttonService = this.accessory.addService(Service.StatelessProgrammableSwitch, `Button ${i}`, `button${i}`);
        buttonService.setCharacteristic(Characteristic.ServiceLabelIndex, i);
        this.buttonServices[i - 1] = buttonService;
        this.log(`Added button service for Button ${i}`);
      }

      this.lightService = this.accessory.addService(Service.Lightbulb, 'LED');
      this.lightService.setCharacteristic(Characteristic.On, true);
      this.log('Added LED light service');

      this.lightService.getCharacteristic(Characteristic.On)
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

      this.lightService.getCharacteristic(Characteristic.Brightness)
        .onGet(() => {
          if (!this.connected) throw new Error('Device not connected');
          return this.rgbToHsv(this.ledColor.r, this.ledColor.g, this.ledColor.b).v;
        })
        .onSet((value) => {
          if (!this.connected) throw new Error('Device not connected');
          const h = this.lightService.getCharacteristic(Characteristic.Hue).value;
          const s = this.lightService.getCharacteristic(Characteristic.Saturation).value;
          const { r, g, b } = this.hsvToRgb(h, s, value);
          this.setLED(r, g, b);
        });

      this.lightService.getCharacteristic(Characteristic.Hue)
        .onGet(() => {
          if (!this.connected) throw new Error('Device not connected');
          return this.rgbToHsv(this.ledColor.r, this.ledColor.g, this.ledColor.b).h;
        })
        .onSet((value) => {
          if (!this.connected) throw new Error('Device not connected');
          const s = this.lightService.getCharacteristic(Characteristic.Saturation).value;
          const v = this.lightService.getCharacteristic(Characteristic.Brightness).value;
          const { r, g, b } = this.hsvToRgb(value, s, v);
          this.setLED(r, g, b);
        });

      this.lightService.getCharacteristic(Characteristic.Saturation)
        .onGet(() => {
          if (!this.connected) throw new Error('Device not connected');
          return this.rgbToHsv(this.ledColor.r, this.ledColor.g, this.ledColor.b).s;
        })
        .onSet((value) => {
          if (!this.connected) throw new Error('Device not connected');
          const h = this.lightService.getCharacteristic(Characteristic.Hue).value;
          const v = this.lightService.getCharacteristic(Characteristic.Brightness).value;
          const { r, g, b } = this.hsvToRgb(h, value, v);
          this.setLED(r, g, b);
        });

      this.accessory.updateReachability(this.connected);
      this.log('Accessories setup completed');
      this.processQueuedEvents();
      callback([this.accessory]);
    } catch (e) {
      this.log(`Error in accessories setup: ${e.message}`);
      this.log(`HAP-NodeJS details: ${JSON.stringify(Object.keys(require('hap-nodejs')))}`);
      callback([]);
    }
  }

  configureAccessory(accessory) {
    this.log('Configuring cached accessory');
    try {
      this.accessory = accessory;
      this.accessory.updateReachability(this.connected);
      this.buttonServices = [];
      accessory.services.forEach(service => {
        if (service.subtype?.startsWith('button')) {
          const index = parseInt(service.subtype.replace('button', '')) - 1;
          this.buttonServices[index] = service;
        } else if (service.displayName === 'LED') {
          this.lightService = service;
        }
      });
      this.log(`Restored ${this.buttonServices.length} button services`);
      this.processQueuedEvents();
    } catch (e) {
      this.log(`Error in configureAccessory: ${e.message}`);
    }
  }
}

module.exports = (api) => {
  console.log('Registering IPortSMButtons platform');
  api.registerPlatform('IPortSMButtons', IPortSMButtonsPlatform);
};
