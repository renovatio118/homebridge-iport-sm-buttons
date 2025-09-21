const net = require('net');

let Service, Characteristic;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  api.registerPlatform('IPortSMButtons', IPortSMButtonsPlatform);
};

class IPortSMButtonsPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.config = config || {};
    this.ip = config.ip || '192.168.2.12';
    this.port = config.port || 10001;
    this.accessories = [];
    this.buttonStates = Array.from({ length: 10 }, () => ({ state: 0, timer: null, lastPress: 0 }));
    this.ledColor = { r: 255, g: 255, b: 255 }; // Default white
    this.socket = null;
    this.connected = false;
    this.connectAttempts = 0;
    this.maxAttemptsPerCycle = 1; // Stick to 10001 since it works
    this.accessory = null;

    this.log('IPortSMButtonsPlatform initialized');
    this.connect();
  }

  connect() {
    this.log(`Attempting connection to ${this.ip}:${this.port}`);
    this.socket = new net.Socket();
    this.socket.setTimeout(5000);

    this.socket.connect(this.port, this.ip, () => {
      this.log(`Connected to ${this.ip}:${this.port}`);
      this.connected = true;
      this.connectAttempts = 0;
      try {
        this.queryLED();
      } catch (e) {
        this.log(`Error querying LED: ${e.message}`);
      }
      if (this.accessory) this.accessory.updateReachability(true);
    });

    this.socket.on('data', (data) => {
      const str = data.toString().trim();
      this.log(`Received raw: ${str}`);
      const parts = str.split('led=');
      parts.forEach((part, index) => {
        if (index === 0 && part.trim()) {
          try {
            const json = JSON.parse(part);
            if (json.events) {
              json.events.forEach((event) => {
                const keyNum = parseInt(event.label.split(' ')[1], 10) - 1;
                const state = parseInt(event.state, 10);
                this.handleButtonEvent(keyNum, state);
              });
            }
          } catch (e) {
            this.log(`JSON parse error: ${e.message}`);
          }
        }
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
    });

    this.socket.on('error', (err) => {
      this.log(`Error on ${this.port}: ${err.message}`);
      this.socket.destroy();
      this.connected = false;
      this.connectAttempts++;
      if (this.accessory) this.accessory.updateReachability(false);
      setTimeout(() => this.connect(), 5000);
    });

    this.socket.on('close', () => {
      this.log('Connection closed');
      this.connected = false;
      if (this.accessory) this.accessory.updateReachability(false);
      setTimeout(() => this.connect(), 5000);
    });

    this.socket.on('timeout', () => {
      this.log('Connection timeout');
      this.socket.destroy();
    });
  }

  handleButtonEvent(buttonIndex, state) {
    if (!this.connected) return;
    const service = this.accessories[buttonIndex];
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
    const service = this.accessories[buttonIndex];
    service.updateCharacteristic(Characteristic.ProgrammableSwitchEvent, eventType);
    const typeStr = eventType === 0 ? 'single' : eventType === 1 ? 'double' : 'long';
    this.log(`Button ${buttonIndex + 1} triggered ${typeStr} press`);
  }

  setLED(r, g, b) {
    if (!this.connected) return;
    const cmd = `\rled=${r.toString().padStart(3, '0')}${g.toString().padStart(3, '0')}${b.toString().padStart(3, '0')}\r`;
    this.socket.write(cmd);
    this.ledColor = { r, g, b };
    this.log(`Set LED to ${r},${g},${b}`);
  }

  queryLED() {
    if (!this.connected) return;
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
    if (!this.lightService || !this.connected) return;
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
      const uuid = this.api.hap.uuid.generate(this.config.name || 'iPort SM Buttons');
      this.accessory = new this.api.platformAccessory(this.config.name || 'iPort SM Buttons', uuid);

      // Service Label
      const serviceLabel = this.accessory.addService(Service.ServiceLabel);
      serviceLabel.setCharacteristic(Characteristic.ServiceLabelNamespace, 1);

      // Buttons
      for (let i = 1; i <= 10; i++) {
        const buttonService = this.accessory.addService(Service.StatelessProgrammableSwitch, `Button ${i}`, `button${i}`);
        buttonService.setCharacteristic(Characteristic.ServiceLabelIndex, i);
        this.accessories[i - 1] = buttonService;
      }

      // LED Light
      this.lightService = this.accessory.addService(Service.Lightbulb, 'LED');
      this.lightService.setCharacteristic(Characteristic.On, true);

      // Bind handlers with connection check
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

      this.log('Accessories setup completed, publishing accessory');
      callback([this.accessory]);
    } catch (e) {
      this.log(`Error in accessories setup: ${e.message}`);
      callback([]); // Return empty to prevent Homebridge crash
    }
  }
}
