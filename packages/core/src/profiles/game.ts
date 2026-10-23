import { basicProfile } from './basic.js';

export const game = basicProfile({
  id: 'game',
  label: 'Game',
  signalWords: [
    'game', 'platformer', 'roguelike', 'pong', 'snake', 'tetris', 'shooter', 'puzzle game', 'godot',
    'pygame', 'unity', 'unreal', 'bevy', 'phaser', 'raylib', 'game engine', 'sprite', 'multiplayer',
  ],
  layers: [
    ['engine', 'Engine or framework', 'Foundation', 'Godot, Pygame, raylib, Bevy, Phaser, a bare canvas or SDL.'],
    ['simulation-core', 'Simulation core', 'Core', 'The deterministic game state and rules, with no rendering.'],
    ['game-loop', 'Game loop and timing', 'Core', 'A fixed timestep that updates and draws.'],
    ['rendering', 'Rendering', 'Output', 'Drawing the state to the screen.'],
    ['input', 'Input', 'Interface', 'Keys, mouse or pads, turned into data.'],
    ['physics', 'Physics and collision', 'Core', 'Movement and what touches what.'],
    ['scene', 'Scene graph or ECS', 'Core', 'How game objects are organised.'],
    ['audio', 'Audio', 'Output', 'Sound effects and music.'],
    ['assets', 'Assets', 'Content', 'Sprites, models and sounds, or placeholder shapes.'],
    ['ui-hud', 'UI and HUD', 'Interface', 'Menus, score and health bars.'],
    ['saves', 'Saves', 'Data', 'Keeping progress between sessions.'],
    ['export', 'Export', 'Ship', 'Building a playable release.'],
  ],
  requiredLayersByTier: {
    T1: ['engine', 'simulation-core'],
    T2: ['engine', 'simulation-core', 'game-loop', 'input'],
    T3: ['engine', 'simulation-core', 'game-loop', 'rendering', 'input', 'physics', 'saves'],
    T4: ['engine', 'simulation-core', 'game-loop', 'rendering', 'input', 'physics', 'scene', 'audio', 'saves'],
    T5: [
      'engine', 'simulation-core', 'game-loop', 'rendering', 'input', 'physics', 'scene', 'audio',
      'assets', 'ui-hud', 'saves', 'export',
    ],
  },
  tierFloors: [
    { goal: 'A game with levels and saves', tier: 'T3', keywords: ['levels', 'saves', 'save game', 'save games'] },
    { goal: 'A networked game', tier: 'T4', keywords: ['multiplayer', 'networked', 'online'] },
    { goal: 'A game engine', tier: 'T5', keywords: ['game engine', 'engine from scratch', 'editor'] },
  ],
  rule: 'Fixed timestep, seeded RNG, input as data, and no rendering or engine calls in core/.',
  harnesses: ['sim-ticks', 'unit', 'golden-image'],
  browser: true,
});
