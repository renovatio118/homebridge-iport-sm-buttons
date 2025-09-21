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
    this.ip = this.config.ip || '192.168.2.12';
    this.port = this.config.port || 10001;
    this.timeout = this.config.timeout || 10000; // Increased to 10 seconds
    this.reconnectDelay = this.config.reconnectDelay || 5000;
    this.buttonServices = [];
    this.buttonStates = Array.from({ length: 10 }, () => ({ state: 0, timer: null, lastPress: 0 }));
    this.ledColor = { r: 255, g: 255, b: 255 };
    this.connected = false;
    this.socket = null;
    this.isPublishing = false;
    this.isShuttingDown = false;
    this.keepAliveInterval = null;

    Service = this.api.hap.Service;
    Characteristic = this.api.hap.Characteristic;
    Accessory = this.api.platformAccessory;
    uuid = this.api.hap.uuid;

    this.log('IPortSMButtonsPlatform initialized');
    this.connect();

    this.api.on('shutdown', () => {
      this.isShuttingDown = true;
      this.log('Homebridge shutting down, delaying socket close');
      if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
      setTimeout(() => {
        if (this.socket) {
          this.socket.destroy();
          this.log('Socket closed');
        }
      }, 2000); // Increased to 2 seconds
    });
  }

  connect() {
    this.log(`Attempting connection to ${this.ip}:${this.port}`);
    this.socket = new net.Socket();
    this.socket.setTimeout(this.timeout);

    this.socket.connect(this.port, this.ip, () => {
      this.log(`Connected to ${this.ip}:${this.port}`);
      this.connected = true;
      this.queryLED();
      if (this.accessory && !this.isShuttingDown) this.accessory.updateReachability(true);
      if (!this.keepAliveInterval) {
        this.keepAliveInterval = setInterval(() => {
          if (this.connected && !this.isShuttingDown) this.queryLED();
        }, 5000); // Query every 5 seconds
      }
    });

    this.socket.on('data', (data) => {
      if (this.isShuttingDown) return;
      const str = data.toString().trim();
      this.log(`Received raw: ${str}`);
      try {
        const json = JSON.parse(str);
        if (json.events) {
          json.events.forEach((event) => {
            const keyNum = parseInt(event.label.split(' ')[1], 10) - 1;
            const state = parseInt(event.state, 10);
            this.handleButtonEvent(keyNum, state);
          });
        }
      } catch (e) {
        // If not JSON, check for LED data
        const parts = str.split('led=');
        parts.forEach((part, index) => {
          if (index > 0 || (index === 0 && !part.trim() && parts.length > 1)) {
            const ledValue = part.trim();
            if (ledValue) {
              try {
                let value = ledValue;
                if (value.startsWith('#')) {
                  value = value.slice(1);
                  this.ledColor.r = parseInt(value.substr(0, 2), 16);
                  this.ledColor.g = parseInt(value.substr(2, 2), 16);
                  this.ledColor.b = parseInt(value.substr(4, 2), 16);
                } else {
                  this.ledColor.r = parseInt(value.substr(0, 3));
                  this.ledColor.g = parseInt(value.substr(3, 3));
                  this.ledColor.b = parseInt(value.substr(6, 3));
                }
                this.log(`LED color updated: ${this.ledColor.r},${this.ledColor.g},${this.ledColor.b}`);
                this.updateLightCharacteristics();
              } catch (e) {
                this.log(`LED parse error: ${e.message}`);
              }
            }
          }
        });
      }
    });

    this.socket.on('error', (err) => {
      this.log(`Socket error on ${this.port}: ${err.message}`);
      this.socket.destroy();
      this.connected = false;
      if (this.accessory && !this.isShuttingDown) this.accessory.updateReachability(false);
      if (!this.isShuttingDown) setTimeout(() => this.connect(), this.reconnectDelay);
    });

    this.socket.on('close', () => {
      this.log('Connection closed');
      this.connected = false;
      if (this.accessory && !this.isShuttingDown) this.accessory.updateReachability(false);
      if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
      if (!this.isShuttingDown) setTimeout(() => this.connect(), this.reconnectDelay);
    });

    this.socket.on('timeout', () => {
      this.log('Connection timeout');
      this.socket.destroy();
    });
  }

  handleButtonEvent(buttonIndex, state) {
    if (!this.connected || this.isShuttingDown) return;
    const service = this.buttonServices[buttonIndex];
    if (!service) return;
    const now = Date.now();
    const bs = this.buttonStates[buttonIndex];

    if (state === 1) {
      if (bs.state === 0) {
        bs.state = 1;
        if (now - bs.lastPress < 500) {
          this.triggerButtonEvent(buttonIndex, 1); // Double press
        } else {
          bs.timer = setTimeout(() => {
            this.triggerButtonEvent(buttonIndex, 2); // Long press
            bs.timer = null;
          }, 800);
        }
        bs.lastPress = now;
      }
    } else if (state === 0) {
      if (bs.state === 1) {
        bs.state = 0;
        if (bs.timer) {
          clearTimeout(bs.timer);
          bs.timer = null;
          this.triggerButtonEvent(buttonIndex, 0); // Single press
        }
      }
    }
  }

  triggerButtonEvent(buttonIndex, eventType) {
    if (this.isShuttingDown) return;
    const service = this.buttonServices[buttonIndex];
    service.updateCharacteristic(Characteristic.ProgrammableSwitchEvent, eventType);
    const typeStr = eventType === 0 ? 'single' : eventType === 1 ? 'double' : 'long';
    this.log(`Button ${buttonIndex + 1} triggered ${typeStr} press`);
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
      case 2: r = p; g = v; b = t; break;
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
      this.accessory.publish({ port: 43715 }); // Pre-publish to avoid setupURI error

      // Service Label
      const serviceLabel = this.accessory.addService(Service.ServiceLabel);
      serviceLabel.setCharacteristic(Characteristic.ServiceLabelNamespace, 1);

      // Buttons
      this.buttonServices = [];
      for (let i = 1; i <= 10; i++) {
        const buttonService = this.accessory.addService(Service.StatelessProgrammableSwitch, `Button ${i}`, `button${i}`);
        buttonService.setCharacteristic(Characteristic.ServiceLabelIndex, i);
        this.buttonServices[i - 1] = buttonService;
      }

      // LED Light
      this.lightService = this.accessory.addService(Service.Lightbulb, 'LED');
      this.lightService.setCharacteristic(Characteristic.On, true);

      // Bind handlers
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

      // Initial reachability
      this.accessory.updateReachability(this.connected);

      // Publish accessory within the callback
      this.isPublishing = true;
      this.api.publishExternalAccessories('IPortSMButtons', [this.accessory]);
      this.isPublishing = false;
      this.log('Accessories setup completed');
      callback([this.accessory]);
    } catch (e) {
      this.log(`Error in accessories setup: ${e.message}`);
      callback([]); // Prevent crash
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
  }
}
