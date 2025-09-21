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
    this.maxAttemptsPerCycle = 2; // Try 10001, then 80
    this.accessory = null;

    // Start connection in background
    this.connect();
  }

  connect() {
    const currentPort = this.connectAttempts % this.maxAttemptsPerCycle === 0 ? this.port : 80;
    this.log(`Attempting connection to ${this.ip}:${currentPort}`);
    this.socket = new net.Socket();
    this.socket.setTimeout(5000);

    this.socket.connect(currentPort, this.ip, () => {
      this.log(`Connected to ${this.ip}:${currentPort}`);
      this.connected = true;
      this.connectAttempts = 0;
      this.queryLED();
      if (this.accessory) this.accessory.updateReachability(true);
    });

    this.socket.on('data', (data) => {
      const str = data.toString().trim();
      this.log(`Received: ${str}`);
      if (str.startsWith('led=')) {
        // Parse LED response
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
        this.updateLightCharacteristics();
      } else {
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
          this.log(`Parse error: ${e.message}`);
        }
      }
    });

    this.socket.on('error', (err) => {
      this.log(`Error on ${currentPort}: ${err.message}`);
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

  // ... (handleButtonEvent, triggerButtonEvent, setLED, queryLED, rgbToHsv, hsvToRgb unchanged from previous version)

  updateLightCharacteristics() {
    if (!this.lightService) return;
    const hsv = this.rgbToHsv(this.ledColor.r, this.ledColor.g, this.ledColor.b);
    this.lightService
      .updateCharacteristic(Characteristic.On, hsv.v > 0)
      .updateCharacteristic(Characteristic.Hue, hsv.h)
      .updateCharacteristic(Characteristic.Saturation, hsv.s)
      .updateCharacteristic(Characteristic.Brightness, hsv.v);
  }

  accessories(callback) {
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

    // Bind handlers with checks for connection
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

    // Similar for Brightness, Hue, Saturation (add !connected check and throw error)

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

    callback([this.accessory]);
  }
}
