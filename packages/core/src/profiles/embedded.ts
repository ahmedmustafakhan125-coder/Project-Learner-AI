import { basicProfile } from './basic.js';

export const embedded = basicProfile({
  id: 'embedded',
  label: 'Embedded',
  signalWords: [
    'microcontroller', 'arduino', 'raspberry pi pico', 'pico', 'esp32', 'stm32', 'firmware', 'embedded',
    'sensor', 'iot', 'rtos', 'freertos', 'weather station',
  ],
  layers: [
    ['board', 'Board', 'Hardware', 'The microcontroller board.'],
    ['sdk', 'SDK', 'Foundation', 'The vendor SDK or framework: Pico SDK, ESP-IDF, Arduino, Embassy.'],
    ['peripherals', 'Peripherals', 'Hardware', 'Sensors, displays and buses: GPIO, I2C, SPI, UART.'],
    ['rtos', 'RTOS', 'Core', 'A real-time OS, or a bare loop.'],
    ['toolchain', 'Toolchain', 'Tools', 'The cross-compiler and build.'],
    ['flashing', 'Flashing', 'Tools', 'How firmware gets onto the board.'],
    ['hal', 'Hardware abstraction', 'Core', 'The layer that lets logic run on the host.'],
    ['testing', 'Testing', 'Quality', 'Host unit tests and static checks.'],
  ],
  requiredLayersByTier: {
    T1: ['board', 'sdk'],
    T2: ['board', 'sdk', 'peripherals', 'flashing'],
    T3: ['board', 'sdk', 'peripherals', 'toolchain', 'flashing', 'hal', 'testing'],
    T4: ['board', 'sdk', 'peripherals', 'rtos', 'toolchain', 'flashing', 'hal', 'testing'],
    T5: ['board', 'sdk', 'peripherals', 'rtos', 'toolchain', 'flashing', 'hal', 'testing'],
  },
  tierFloors: [{ goal: 'Firmware on a board', tier: 'T2', keywords: [] }],
  rule: 'A hardware abstraction layer so the logic runs and is tested on the host.',
  harnesses: ['unit'],
});
