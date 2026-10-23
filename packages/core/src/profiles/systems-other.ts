import { basicProfile } from './basic.js';

export const systemsOther = basicProfile({
  id: 'systems-other',
  label: 'Systems project',
  signalWords: [
    'emulator', 'chip-8', 'chip8', 'nes', 'gameboy', 'game boy', 'key-value store', 'key value store',
    'database engine', 'storage engine', 'allocator', 'malloc', 'http server', 'raw sockets', 'sockets',
  ],
  layers: [
    ['language', 'Language', 'Foundation', 'The language it is written in.'],
    ['core-logic', 'Deterministic core', 'Core', 'The CPU core, storage engine or protocol logic, driven by fixtures.'],
    ['memory-model', 'Memory model', 'Core', 'The memory map, page layout or allocator design.'],
    ['io', 'I/O', 'Platform', 'Files, sockets or the display and keys.'],
    ['display', 'Display', 'Output', 'The screen of an emulator, if it has one.'],
    ['persistence', 'Persistence', 'Data', 'What is written to disk and how it is recovered.'],
    ['testing', 'Testing', 'Quality', 'Test ROMs, fixtures and golden runs.'],
  ],
  requiredLayersByTier: {
    T1: ['language', 'core-logic'],
    T2: ['language', 'core-logic', 'testing'],
    T3: ['language', 'core-logic', 'memory-model', 'io', 'testing'],
    T4: ['language', 'core-logic', 'memory-model', 'io', 'testing'],
    T5: ['language', 'core-logic', 'memory-model', 'io', 'persistence', 'testing'],
  },
  tierFloors: [
    { goal: 'A CHIP-8 emulator or a small server', tier: 'T2', keywords: [] },
    {
      goal: 'A NES or Game Boy emulator, or a storage engine',
      tier: 'T4',
      keywords: ['nes', 'gameboy', 'game boy', 'storage engine', 'database engine'],
    },
  ],
  rule: 'A deterministic core driven by test ROMs or fixtures.',
  harnesses: ['exec-golden', 'unit', 'golden-image'],
});
