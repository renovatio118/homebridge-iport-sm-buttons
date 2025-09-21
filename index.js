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
    this.port = config.port || 10001; // Default to 10001, try 80 if fails
    this.accessories = [];
    this.buttonStates = Array.from({ length: 10 }, () => ({ state: 0, timer: null, lastPress: 0 }));
    this.ledColor = { r: 255, g: 255, b: 255 }; // Default white
    this.socket = null;
    this.ready = false;
    this.accessory = null;
    this.connectAttempts = 0;
    this.maxAttempts = 2; // Try port 10001, then 80

    this.connect();
  }

  connect() {
    this.socket = new net.Socket();
    const currentPort = this.connectAttempts === 0 ? this.port : 80; // Try 10001 first, then 80
    this.log(`Attempting connection to ${this.ip}:${currentPort} (Attempt ${this.connectAttempts + 1}/${this.maxAttempts})`);
    this.socket.connect(currentPort, this.ip, () => {
      this.log(`Connected to ${this.ip}:${currentPort}`);
      this.ready = true;
      this.queryLED();
      if (this.accessory) this.api.publishExternalAccessories('IPortSMButtons', [this.accessory]);
    });

    this.socket.on('error', (err) => {
      this.log(`Socket error on ${this.ip}:${currentPort}: ${err.message}.`);
      this.socket.destroy();
      if (this.connectAttempts < this.maxAttempts - 1) {
        this.connectAttempts++;
        setTimeout(() => this.connect(), 5000); // Retry with next port
      } else {
        this.log('Failed to connect on all ports. Ensure device is configured for TCP on 10001 or 80.');
      }
    });

    this.socket.on('data', (data) => {
      const str = data.toString().trim();
      this.log(`Received raw data: ${str}`);
      if (str.startsWith('led=')) {
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
        if (this.lightService) {
          const hsv = this.rgbToHsv(this.ledColor.r, this.ledColor.g, this.ledColor.b);
          this.lightService
            .updateCharacteristic(Characteristic.On, hsv.v > 0)
            .updateCharacteristic(Characteristic.Hue, hsv.h)
            .updateCharacteristic(Characteristic.Saturation, hsv.s)
            .updateCharacteristic(Characteristic.Brightness, hsv.v);
        }
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
          this.log(`Error parsing data: ${e.message}`);
        }
      }
    });

    this.socket.on('close', () => {
      this.log('Connection closed, retrying in 5s...');
      this.ready = false;
      setTimeout(() => this.connect(), 5000);
    });
  }

  // ... (rest of the methods: handleButtonEvent, triggerButtonEvent, setLED, queryLED, rgbToHsv, hsvToRgb remain unchanged)

  publishAccessories() {
    if (this.ready) {
      const uuid = this.api.hap.uuid.generate(this.config.name || 'iPort SM Buttons');
      this.accessory = new this.api.platformAccessory(this.config.name || 'iPort SM Buttons', uuid);

      const serviceLabel = this.accessory.addService(Service.ServiceLabel);
      serviceLabel.setCharacteristic(Characteristic.ServiceLabelNamespace, 1);

      for (let i = 1; i <= 10; i++) {
        const buttonService = this.accessory.addService(Service.StatelessProgrammableSwitch, `Button ${i}`, `button${i}`);
        buttonService.setCharacteristic(Characteristic.ServiceLabelIndex, i);
        this.accessories[i - 1] = buttonService;
      }

      this.lightService = this.accessory.addService(Service.Lightbulb, 'LED');
      this.lightService.setCharacteristic(Characteristic.On, true);

      this.lightService.getCharacteristic(Characteristic.On)
        .onGet(() => {
          const hsv = this.rgbToHsv(this.ledColor.r, this.ledColor.g, this.ledColor.b);
          return hsv.v > 0;
        })
        .onSet((value) => {
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

      this.api.publishExternalAccessories('IPortSMButtons', [this.accessory]);
    } else {
      this.log('Waiting for connection before publishing accessories...');
      setTimeout(() => this.publishAccessories(), 5000);
    }
  }

  accessories(callback) {
    callback([]); // Return empty initially to avoid assertion error
    this.publishAccessories(); // Start the publishing process
  }
}
