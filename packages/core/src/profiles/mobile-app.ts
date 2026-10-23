import { basicProfile } from './basic.js';

export const mobileApp = basicProfile({
  id: 'mobile-app',
  label: 'Mobile app',
  signalWords: [
    'mobile', 'mobile app', 'phone', 'iphone', 'android', 'ios', 'react native', 'flutter',
    'expo', 'kotlin', 'habit tracker',
  ],
  layers: [
    ['framework', 'Framework', 'Interface', 'What the app is built with: React Native, Flutter, SwiftUI or Jetpack Compose.'],
    ['navigation', 'Navigation', 'Interface', 'How screens are reached.'],
    ['state', 'State', 'Core', 'Where the app data lives while it runs.'],
    ['storage', 'Storage', 'Data', 'What is kept on the device.'],
    ['native-apis', 'Native APIs', 'Platform', 'Camera, notifications, location and other device features.'],
    ['build', 'Build', 'Ship', 'How the app is built and installed on a device.'],
  ],
  requiredLayersByTier: {
    T1: ['framework'],
    T2: ['framework', 'navigation', 'state'],
    T3: ['framework', 'navigation', 'state', 'storage', 'build'],
    T4: ['framework', 'navigation', 'state', 'storage', 'native-apis', 'build'],
    T5: ['framework', 'navigation', 'state', 'storage', 'native-apis', 'build'],
  },
  tierFloors: [{ goal: 'A phone app', tier: 'T2', keywords: [] }],
  rule: 'The core holds the logic and imports nothing from the UI.',
  harnesses: ['unit'],
});
