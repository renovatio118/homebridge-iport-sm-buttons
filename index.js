const net = require('net');

let Service, Characteristic, Accessory, uuid;

module.exports = (api) => {
  api.registerPlatform('IPortSMButtons', IPortSMButtonsPlatform);
};

class IPortSMButtonsPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    
    // Log the configuration we received
    this.log('IPortSMButtonsPlatform constructor called');
    this.log(`Configuration: ${JSON.stringify(config, null, 2)}`);
    
    this.ip = this.config.ip || '192.168.2.12';
    this.port = this.config.port || 10001;
    this.timeout = this.config.timeout || 10000;
    this.reconnectDelay = this.config.reconnectDelay || 5000;
    
    this.log(`Using IP: ${this.ip}, Port: ${this.port}`);
    
    // Initialize other properties
    this.buttonServices = [];
    this.buttonStates = Array.from({ length: 10 }, () => ({ state: 0, lastPress: 0 }));
    this.ledColor = { r: 255, g: 255, b: 255 };
    this.connected = false;
    this.socket = null;
    this.isPublishing = false;
    this.isShuttingDown = false;
    this.keepAliveInterval = null;
    this.eventQueue = [];
    this.lastLoggedColor = null;
    this.lastRawData = null;
    
    // Mode configuration
    this.modeColors = {
      yellow: { r: 255, g: 255, b: 0 },
      red: { r: 255, g: 0, b: 0 },
      blue: { r: 0, g: 0, b: 255 },
      green: { r: 0, g: 255, b: 0 },
      purple: { r: 128, g: 0, b: 128 },
      white: { r: 255, g: 255, b: 255 }
    };
    
    // Color cycle for button 10
    this.colorCycle = ['red', 'green', 'blue', 'yellow', 'purple', 'white'];
    this.currentColorIndex = 0;
    
    // Store button mappings from config
    this.buttonMappings = this.config.buttonMappings || [];
    this.log(`Button mappings: ${JSON.stringify(this.buttonMappings, null, 2)}`);

    Service = this.api.hap.Service;
    Characteristic = this.api.hap.Characteristic;
    Accessory = this.api.platformAccessory;
    uuid = this.api.hap.uuid;

    this.log('IPortSMButtonsPlatform initialized');
    
    this.api.on('shutdown', () => {
      this.isShuttingDown = true;
      this.log('Homebridge shutting down, delaying socket close');
      if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
      setTimeout(() => {
        if (this.socket) {
          this.socket.destroy();
          this.log('Socket closed');
        }
      }, 2000);
    });
  }

  connect() {
    this.log('Attempting to connect to device...');
    
    if (this.socket && !this.socket.destroyed) {
      this.log('Already connected or connecting');
      return;
    }
    
    this.log(`Creating socket connection to ${this.ip}:${this.port}`);
    this.socket = new net.Socket();
    this.socket.setTimeout(this.timeout);

    this.socket.connect(this.port, this.ip, () => {
      this.log(`SUCCESS: Connected to ${this.ip}:${this.port}`);
      this.connected = true;
      if (this.accessory && !this.isShuttingDown) this.accessory.updateReachability(true);
      
      // Start querying LED status
      this.queryLED();
      
      if (!this.keepAliveInterval) {
        this.keepAliveInterval = setInterval(() => {
          if (this.connected && !this.isShuttingDown) this.queryLED();
        }, 5000);
      }
      
      // Process any queued events now that we're connected
      this.processQueuedEvents();
    });

    this.socket.on('data', (data) => {
      if (this.isShuttingDown) return;
      const str = data.toString().trim();
      this.log(`Received data: ${str}`);
      
      // Only log raw data if it's different from the last received data
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
        // If not JSON, check for LED data
        if (str.includes('led=')) {
          const parts = str.split('led=');
          parts.forEach((part, index) => {
            if (index > 0 || (index === 0 && !part.trim() && parts.length > 1)) {
              const ledValue = part.trim();
              if (ledValue) {
                try {
                  let value = ledValue;
                  let newR, newG, newB;
                  
                  if (value.startsWith('#')) {
                    value = value.slice(1);
                    newR = parseInt(value.substr(0, 2), 16);
                    newG = parseInt(value.substr(2, 2), 16);
                    newB = parseInt(value.substr(4, 2), 16);
                  } else {
                    newR = parseInt(value.substr(0, 3));
                    newG = parseInt(value.substr(3, 3));
                    newB = parseInt(value.substr(6, 3));
                  }
                  
                  // Check if the color has changed
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
          });
        }
      }
    });

    this.socket.on('error', (err) => {
      this.log(`Socket error: ${err.message}`);
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
      if (this.accessory && !this.isShuttingDown) this.accessory.updateReachability(false);
      if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
      if (!this.isShuttingDown) setTimeout(() => this.connect(), this.reconnectDelay);
    });

    this.socket.on('close', () => {
      this.log('Connection closed');
      this.socket = null;
      this.connected = false;
      if (this.accessory && !this.isShuttingDown) this.accessory.updateReachability(false);
      if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
      if (!this.isShuttingDown) setTimeout(() => this.connect(), this.reconnectDelay);
    });

    this.socket.on('timeout', () => {
      this.log('Connection timeout');
      this.socket.destroy();
      this.socket = null;
    });
  }

  queueOrHandleEvent(buttonIndex, state) {
    // Check if button services are available
    if (this.buttonServices.length === 0 || !this.buttonServices[buttonIndex]) {
      this.eventQueue.push({ buttonIndex, state });
      this.log(`Queued event for button ${buttonIndex + 1}, state ${state}`);
    } else {
      this.handleButtonEvent(buttonIndex, state);
    }
  }

  processQueuedEvents() {
    if (this.eventQueue.length > 0) {
      this.log(`Processing ${this.eventQueue.length} queued events`);
    }
    
    while (this.eventQueue.length > 0) {
      const event = this.eventQueue.shift();
      this.handleButtonEvent(event.buttonIndex, event.state);
    }
  }

  handleButtonEvent(buttonIndex, state) {
    if (!this.connected || this.isShuttingDown) return;
    
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
    if (!service) return;
    
    service.updateCharacteristic(Characteristic.ProgrammableSwitchEvent, eventType);
    const typeStr = eventType === 0 ? 'single' : eventType === 1 ? 'double' : 'long';
    this.log(`Button ${buttonIndex + 1} triggered ${typeStr} press`);
    
    // Execute the assigned action for this button based on current mode
    if (eventType === 0) { // Only handle single presses for actions
      this.executeButtonAction(buttonIndex + 1);
    }
  }

  // Method to execute actions based on button press and current LED mode
  executeButtonAction(buttonNumber) {
    // Special handling for button 10 - cycle through colors
    if (buttonNumber === 10) {
      this.cycleLEDColor();
      return;
    }
    
    // Find actions for this button
    const actions = this.buttonMappings.filter(action => action.buttonNumber === buttonNumber);
    
    if (actions.length === 0) {
      this.log(`No actions configured for button ${buttonNumber}`);
      return;
    }
    
    // Determine current mode based on LED color
    const currentMode = this.getCurrentMode();
    
    // Find the action for the current mode
    let actionToExecute = actions.find(action => action.modeColor === currentMode);
    
    if (!actionToExecute) {
      // Look for an "any" mode fallback
      actionToExecute = actions.find(action => action.modeColor === 'any');
      
      if (!actionToExecute) {
        this.log(`No action found for button ${buttonNumber} in ${currentMode} mode`);
        return;
      }
    }
    
    this.log(`Executing action for button ${buttonNumber}: ${JSON.stringify(actionToExecute)}`);
    
    // Execute the action based on type
    if (actionToExecute.actionType === 'scene') {
      this.executeSceneAction(actionToExecute);
    } else if (actionToExecute.actionType === 'led') {
      this.executeLedAction(actionToExecute);
    } else {
      this.executeHomeKitAction(actionToExecute);
    }
  }

  // Special function for button 10 to cycle through colors
  cycleLEDColor() {
    this.currentColorIndex = (this.currentColorIndex + 1) % this.colorCycle.length;
    const colorName = this.colorCycle[this.currentColorIndex];
    const color = this.modeColors[colorName];
    
    this.log(`Button 10 pressed: Cycling to ${colorName} color`);
    this.setLED(color.r, color.g, color.b);
  }

  // Determine the current mode based on LED color
  getCurrentMode() {
    const tolerance = 50; // Color matching tolerance
    
    for (const mode in this.modeColors) {
      const modeColor = this.modeColors[mode];
      if (Math.abs(modeColor.r - this.ledColor.r) <= tolerance &&
          Math.abs(modeColor.g - this.ledColor.g) <= tolerance &&
          Math.abs(modeColor.b - this.ledColor.b) <= tolerance) {
        return mode;
      }
    }
    
    return 'unknown';
  }

  // Execute HomeKit scene actions
  executeSceneAction(action) {
    this.log(`Scene action requested: ${action.targetName}`);
    this.log('Scene support requires additional implementation. Please use accessory control instead.');
  }

  // Execute HomeKit accessory actions
  executeHomeKitAction(action) {
    if (!action.targetName) {
      this.log('No accessory specified for action');
      return;
    }
    
    // Find the accessory by display name in Homebridge
    const targetAccessory = this.findAccessoryByName(action.targetName);
    
    if (!targetAccessory) {
      this.log(`Accessory "${action.targetName}" not found in Homebridge`);
      return;
    }
    
    // Find the appropriate service (try Switch first, then Lightbulb)
    let service = targetAccessory.getService(Service.Switch);
    if (!service) {
      service = targetAccessory.getService(Service.Lightbulb);
    }
    
    if (!service) {
      this.log(`No Switch or Lightbulb service found on accessory "${action.targetName}"`);
      return;
    }
    
    // Get the On characteristic
    const onCharacteristic = service.getCharacteristic(Characteristic.On);
    if (!onCharacteristic) {
      this.log(`No On characteristic found on accessory "${action.targetName}"`);
      return;
    }
    
    // Execute the action
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
      case 'brightness':
        if (action.value) {
          const brightness = parseInt(action.value);
          if (!isNaN(brightness) && brightness >= 0 && brightness <= 100) {
            const brightnessCharacteristic = service.getCharacteristic(Characteristic.Brightness);
            if (brightnessCharacteristic) {
              brightnessCharacteristic.setValue(brightness);
              this.log(`Set brightness of ${action.targetName} to ${brightness}%`);
            } else {
              this.log(`No Brightness characteristic found on accessory "${action.targetName}"`);
            }
          }
        }
        break;
      default:
        this.log(`Unknown action: ${action.action}`);
    }
  }

  // Execute LED color change actions
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

  // Helper method to find an accessory by display name in Homebridge
  findAccessoryByName(name) {
    // Get all accessories registered with Homebridge
    const accessories = this.api.accessories;
    
    // Find the accessory with the matching display name
    for (const accessory of accessories) {
      if (accessory.displayName === name) {
        return accessory;
      }
    }
    
    return null;
  }

  setLED(r, g, b) {
    if (!this.connected || this.isShuttingDown) return;
    const cmd = `\rled=${r.toString().padStart(3, '0')}${g.toString().padStart(3, '0')}${b.toString().padStart(3, '0')}\r`;
    this.socket.write(cmd);
    this.ledColor = { r, g, b };
    this.log(`Set LED to ${r},${g},${b}`);
  }

  queryLED() {
    if (!this.connected || this.isShuttingDown) return;
    this.socket.write('\rled=?\r');
    this.log('Queried LED state');
  }

  rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const v = max;
    const d = max - min;
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
    let r, g, b;
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    switch (i % 6) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g: v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      case 5: r = v; g = p; b = q; break;
    }
    return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
  }

  updateLightCharacteristics() {
    if (!this.lightService || !this.connected || this.isShuttingDown) return;
    const hsv = this.rgbToHsv(this.ledColor.r, this.ledColor.g, this.ledColor.b);
    this.lightService
      .updateCharacteristic(Characteristic.On, hsv.v > 0)
      .updateCharacteristic(Characteristic.Hue, hsv.h)
      .updateCharacteristic(Characteristic.Saturation, hsv.s)
      .updateCharacteristic(Characteristic.Brightness, hsv.v);
  }

  accessories(callback) {
    try {
      this.log('Starting accessories setup');
      const uuidStr = uuid.generate(this.config.name || 'iPort SM Buttons');
      this.accessory = new Accessory(this.config.name || 'iPort SM Buttons', uuidStr);
      this.accessory.publish({ port: 43715 });

      const serviceLabel = this.accessory.addService(Service.ServiceLabel);
      serviceLabel.setCharacteristic(Characteristic.ServiceLabelNamespace, 1);

      this.buttonServices = [];
      for (let i = 1; i <= 10; i++) {
        const buttonService = this.accessory.addService(Service.StatelessProgrammableSwitch, `Button ${i}`, `button${i}`);
        buttonService.setCharacteristic(Characteristic.ServiceLabelIndex, i);
        this.buttonServices[i - 1] = buttonService;
      }

      this.lightService = this.accessory.addService(Service.Lightbulb, 'LED');
      this.lightService.setCharacteristic(Characteristic.On, true);

      this.lightService.getCharacteristic(Characteristic.On)
        .onGet(() => {
          if (!this.connected) throw new Error('Device not connected');
          const hsv = this.rgbToHsv(this.ledColor.r, this.ledColor.g, this.ledColor.b);
          return hsv.v > 0;
        })
        .onSet((value) => {
          if (!this.connected) throw new Error('Device not connected');
          if (value) {
            if (this.ledColor.r === 0 && this.ledColor.g === 0 && this.ledColor.b === 0) {
              this.setLED(255, 255, 255);
            }
          } else {
            this.setLED(0, 0, 0);
          }
        });

      this.lightService.getCharacteristic(Characteristic.Brightness)
        .onGet(() => {
          if (!this.connected) throw new Error('Device not connected');
          const hsv = this.rgbToHsv(this.ledColor.r, this.ledColor.g, this.ledColor.b);
          return hsv.v;
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
          const hsv = this.rgbToHsv(this.ledColor.r, this.ledColor.g, this.ledColor.b);
          return hsv.h;
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
          const hsv = this.rgbToHsv(this.ledColor.r, this.ledColor.g, this.ledColor.b);
          return hsv.s;
        })
        .onSet((value) => {
          if (!this.connected) throw new Error('Device not connected');
          const h = this.lightService.getCharacteristic(Characteristic.Hue).value;
          const v = this.lightService.getCharacteristic(Characteristic.Brightness).value;
          const { r, g, b } = this.hsvToRgb(h, value, v);
          this.setLED(r, g, b);
        });

      this.accessory.updateReachability(this.connected);

      this.isPublishing = true;
      this.api.publishExternalAccessories('IPortSMButtons', [this.accessory]);
      this.isPublishing = false;
      this.log('Accessories setup completed');
      
      // Now connect to the device after accessories are set up
      setTimeout(() => {
        this.log('Attempting connection after accessory setup');
        this.connect();
      }, 1000);
      
      callback([this.accessory]);
    } catch (e) {
      this.log(`Error in accessories setup: ${e.message}`);
      callback([]);
    }
  }

  configurePlatformAccessory(accessory) {
    this.log('Configuring cached accessory');
    accessory.updateReachability(this.connected);
    this.accessory = accessory;
    this.buttonServices = [];
    accessory.services.forEach(service => {
      if (service.subtype && service.subtype.startsWith('button')) {
        const index = parseInt(service.subtype.replace('button', '')) - 1;
        this.buttonServices[index] = service;
      } else if (service.name === 'LED') {
        this.lightService = service;
      }
    });
    
    // Now connect to the device after accessories are configured
    setTimeout(() => {
      this.log('Attempting connection after accessory configuration');
      this.connect();
    }, 1000);
  }
}
