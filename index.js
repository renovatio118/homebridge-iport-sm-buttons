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
    this.config = config;
    this.ip = config.ip || '192.168.2.12';
    this.port = config.port || 10001;
    this.accessories = []; // Will store button services
    this.buttonStates = Array.from({ length: 10 }, () => ({ state: 0, timer: null, lastPress: 0 }));
    this.ledColor = { r: 255, g: 255, b: 255 }; // Default white
    this.socket = null;
    this.connect();
  }

  connect() {
    this.socket = new net.Socket();
    this.socket.connect(this.port, this.ip, () => {
      this.log(`Connected to ${this.ip}:${this.port}`);
      this.queryLED(); // Get initial LED state
    });

    this.socket.on('data', (data) => {
      const str = data.toString().trim();
      if (str.startsWith('led=')) {
        // Parse LED query response
        let value = str.slice(4);
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
        this.log(`Received LED color: ${this.ledColor.r},${this.ledColor.g},${this.ledColor.b}`);
        // Update HomeKit light state
        const hsv = this.rgbToHsv(this.ledColor.r, this.ledColor.g, this.ledColor.b);
        this.lightService
          .updateCharacteristic(Characteristic.On, hsv.v > 0)
          .updateCharacteristic(Characteristic.Hue, hsv.h)
          .updateCharacteristic(Characteristic.Saturation, hsv.s)
          .updateCharacteristic(Characteristic.Brightness, hsv.v);
      } else {
        try {
          const json = JSON.parse(str);
          if (json.events) {
            json.events.forEach((event) => {
              const keyNum = parseInt(event.label.split(' ')[1], 10);
              const buttonIndex = keyNum - 1;
              const state = parseInt(event.state, 10);
              this.handleButtonEvent(buttonIndex, state);
            });
          }
        } catch (e) {
          this.log(`Error parsing data: ${e.message}`);
        }
      }
    });

    this.socket.on('close', () => {
      this.log('Connection closed, reconnecting in 5s...');
      setTimeout(() => this.connect(), 5000);
    });

    this.socket.on('error', (err) => {
      this.log(`Socket error: ${err.message}`);
    });
  }

  handleButtonEvent(buttonIndex, state) {
    const service = this.accessories[buttonIndex];
    if (!service) return;
    const now = Date.now();
    const bs = this.buttonStates[buttonIndex];

    if (state === 1) {
      if (bs.state === 0) {
        // New press
        bs.state = 1;
        if (now - bs.lastPress < 500) {
          // Double press
          this.triggerButtonEvent(buttonIndex, 1); // Double press
        } else {
          // Start long press timer
          bs.timer = setTimeout(() => {
            this.triggerButtonEvent(buttonIndex, 2); // Long press
            bs.timer = null;
          }, 800);
        }
        bs.lastPress = now;
      }
      // Ignore repeats
    } else if (state === 0) {
      if (bs.state === 1) {
        // Release
        bs.state = 0;
        if (bs.timer) {
          clearTimeout(bs.timer);
          bs.timer = null;
          this.triggerButtonEvent(buttonIndex, 0); // Single press
        }
        // If long press already triggered, ignore
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
    const cmd = `\rled=${r.toString().padStart(3, '0')}${g.toString().padStart(3, '0')}${b.toString().padStart(3, '0')}\r`;
    this.socket.write(cmd);
    this.ledColor = { r, g, b };
    this.log(`Set LED to ${r},${g},${b}`);
  }

  queryLED() {
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
    if (max === min) {
      h = 0;
    } else {
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

  accessories(callback) {
    const uuid = this.api.hap.uuid.generate(this.config.name || 'iPort SM Buttons');
    const accessory = new this.api.platformAccessory(this.config.name || 'iPort SM Buttons', uuid);

    // Service Label for grouping buttons
    const serviceLabel = accessory.addService(Service.ServiceLabel);
    serviceLabel.setCharacteristic(Characteristic.ServiceLabelNamespace, 1); // ARABIC_NUMERALS

    // Add 10 buttons
    for (let i = 1; i <= 10; i++) {
      const buttonService = accessory.addService(Service.StatelessProgrammableSwitch, `Button ${i}`, `button${i}`);
      buttonService.setCharacteristic(Characteristic.ServiceLabelIndex, i);
      this.accessories[i - 1] = buttonService;
    }

    // Add LED as Lightbulb
    this.lightService = accessory.addService(Service.Lightbulb, 'LED');
    this.lightService.setCharacteristic(Characteristic.On, true);

    this.lightService.getCharacteristic(Characteristic.On)
      .onGet(() => {
        const hsv = this.rgbToHsv(this.ledColor.r, this.ledColor.g, this.ledColor.b);
        return hsv.v > 0;
      })
      .onSet((value) => {
        if (value) {
          if (this.ledColor.r === 0 && this.ledColor.g === 0 && this.ledColor.b === 0) {
            // Default to full white if turning on from off
            this.setLED(255, 255, 255);
          }
        } else {
          this.setLED(0, 0, 0);
        }
      });

    this.lightService.getCharacteristic(Characteristic.Brightness)
      .onGet(() => {
        const hsv = this.rgbToHsv(this.ledColor.r, this.ledColor.g, this.ledColor.b);
        return hsv.v;
      })
      .onSet((value) => {
        const h = this.lightService.getCharacteristic(Characteristic.Hue).value;
        const s = this.lightService.getCharacteristic(Characteristic.Saturation).value;
        const { r, g, b } = this.hsvToRgb(h, s, value);
        this.setLED(r, g, b);
      });

    this.lightService.getCharacteristic(Characteristic.Hue)
      .onGet(() => {
        const hsv = this.rgbToHsv(this.ledColor.r, this.ledColor.g, this.ledColor.b);
        return hsv.h;
      })
      .onSet((value) => {
        const s = this.lightService.getCharacteristic(Characteristic.Saturation).value;
        const v = this.lightService.getCharacteristic(Characteristic.Brightness).value;
        const { r, g, b } = this.hsvToRgb(value, s, v);
        this.setLED(r, g, b);
      });

    this.lightService.getCharacteristic(Characteristic.Saturation)
      .onGet(() => {
        const hsv = this.rgbToHsv(this.ledColor.r, this.ledColor.g, this.ledColor.b);
        return hsv.s;
      })
      .onSet((value) => {
        const h = this.lightService.getCharacteristic(Characteristic.Hue).value;
        const v = this.lightService.getCharacteristic(Characteristic.Brightness).value;
        const { r, g, b } = this.hsvToRgb(h, value, v);
        this.setLED(r, g, b);
      });

    callback([accessory]);
  }
}
