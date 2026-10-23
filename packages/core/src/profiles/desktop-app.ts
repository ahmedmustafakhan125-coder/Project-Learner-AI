import type { Profile } from './types.js';

/**
 * Desktop applications (docs/project-learner.md §6, "Desktop applications").
 *
 * Verified through a UI-free core and one declared IPC contract, because
 * driving a real window headlessly is fragile and slow.
 */

export const desktopApp: Profile = {
  id: 'desktop-app',
  label: 'Desktop app',
  deep: true,
  signalWords: [
    'desktop',
    'desktop app',
    'desktop application',
    'tray',
    'system tray',
    'installer',
    'tauri',
    'electron',
    'qt',
    'pyside',
    'pyside6',
    'wpf',
    'winui',
    'avalonia',
    'swiftui',
    'gtk',
    'egui',
    'native app',
    'menu bar',
  ],
  layers: [
    {
      id: 'ui-toolkit',
      label: 'UI toolkit',
      section: 'Interface',
      description: 'What draws the windows: Tauri, Electron, Qt, .NET, SwiftUI, GTK or an immediate-mode UI.',
      research: 'tauri',
    },
    {
      id: 'app-architecture',
      label: 'App architecture',
      section: 'Core',
      description: 'How the app is split: main and renderer processes, a Rust core, MVVM. Logic stays out of the UI.',
      research: 'tauri',
    },
    {
      id: 'ipc',
      label: 'IPC and its security model',
      section: 'Core',
      description: 'How the UI calls the core, declared in one contract file, and what the UI is allowed to call.',
      research: 'tauri',
    },
    {
      id: 'local-storage',
      label: 'Local storage',
      section: 'Data',
      description: 'Where data lives on the machine: SQLite or files in the app-data directory.',
      research: 'sqlite',
    },
    {
      id: 'os-integration',
      label: 'OS integration',
      section: 'Platform',
      description: 'Tray icons, notifications, file dialogs and global shortcuts.',
      research: 'tauri',
      check: 'static',
    },
    {
      id: 'packaging',
      label: 'Packaging',
      section: 'Ship',
      description: 'Turning the app into an installer: the Tauri bundler, electron-builder, PyInstaller or jpackage.',
      research: 'tauri',
    },
    {
      id: 'updates',
      label: 'Updates',
      section: 'Ship',
      description: 'How an installed app learns about and installs a new version.',
      research: 'tauri',
      check: 'static',
    },
    {
      id: 'testing',
      label: 'Testing',
      section: 'Core',
      description: 'Unit tests on the UI-free core and contract checks on the IPC surface.',
      research: 'tauri',
    },
  ],
  requiredLayersByTier: {
    T1: ['ui-toolkit'],
    T2: ['ui-toolkit', 'app-architecture', 'packaging'],
    T3: ['ui-toolkit', 'app-architecture', 'ipc', 'local-storage', 'packaging'],
    T4: ['ui-toolkit', 'app-architecture', 'ipc', 'local-storage', 'os-integration', 'packaging', 'updates', 'testing'],
    T5: ['ui-toolkit', 'app-architecture', 'ipc', 'local-storage', 'os-integration', 'packaging', 'updates', 'testing'],
  },
  slots: [
    {
      key: 'target_os',
      label: 'Operating systems',
      description: 'Which operating systems the app must run on: Windows, macOS, Linux.',
      weight: 2,
      required: true,
      suggestedOptions: ['Windows', 'macOS', 'Linux', 'All three'],
    },
    {
      key: 'ui_tech',
      label: 'Web or native UI',
      description: 'Whether the UI is built with web technology (HTML, CSS, JS) or a native toolkit.',
      weight: 2,
      required: true,
      suggestedOptions: ['Web technology', 'Native toolkit', 'Recommend one for me'],
    },
    {
      key: 'offline_data',
      label: 'Offline data',
      description: 'What the app keeps on the machine, if anything.',
      weight: 1,
      required: false,
      minTier: 'T2',
    },
    {
      key: 'os_integration',
      label: 'OS integration',
      description: 'Tray icon, notifications, file access or global shortcuts it needs.',
      weight: 1,
      required: false,
      minTier: 'T3',
      suggestedOptions: ['Tray icon', 'Notifications', 'Files', 'Global shortcuts', 'None'],
    },
    {
      key: 'distribution',
      label: 'Distribution',
      description: 'How it reaches people: an installer, a store, auto-update, code signing.',
      weight: 1,
      required: false,
      minTier: 'T3',
      suggestedOptions: ['Installer', 'App store', 'Auto-update', 'Just run it locally'],
    },
  ],
  tierFloors: [
    { goal: 'A desktop window around a small core', tier: 'T2', keywords: [] },
    { goal: 'A desktop app that keeps data on the machine', tier: 'T3', keywords: ['signal:persistence'] },
  ],
  architectureRule: {
    description:
      'Business logic lives in core/ with no UI imports, and every IPC channel or command is declared ' +
      'in one contract file (ipc.ts, commands.rs).',
    requiredPaths: [
      '**/core/**',
      '**/ipc.ts|**/ipc.js|**/commands.rs|**/ipc.py|**/commands.py',
    ],
    firstStepCreates: ['**/core/**'],
    forbiddenImports: [
      {
        in: '**/core/**',
        packages: ['electron', '@tauri-apps/api', 'tauri', 'react', 'vue', 'svelte', 'PySide6', 'PyQt6', 'tkinter'],
      },
    ],
  },
  harnesses: ['unit', 'artifact', 'headless-app'],
  // "Core only" (§6): the core's unit tests run in the browser for plain
  // JavaScript or stdlib Python. Every common desktop toolkit puts the core in
  // Rust, C++, C# or Swift, so the CLI checks it.
  browserRunnable: (brief) => {
    const core = brief.layers.find((l) => l.layer === 'app-architecture') ?? brief.layers[0];
    const text = `${core?.name ?? ''} ${core?.roleHere ?? ''}`.toLowerCase();
    return /\bpython\b|\bjavascript\b|\bnode\b/.test(text) && !/\brust\b|\bc\+\+|\bc#|\bswift\b/.test(text);
  },
  toolchain: [
    {
      tool: 'node',
      minVersion: null,
      installHint: { linux: 'https://nodejs.org/en/download', macos: 'brew install node', windows: 'winget install OpenJS.NodeJS.LTS' },
    },
  ],
  docSources: [{ key: 'base' }, { key: 'profile:desktop-app' }],
  prerequisites: [
    'Building a small program in the chosen language',
    'Functions, modules and imports',
    'Reading error messages from a build tool',
  ],
  promptAddendum: `<profile_rules profile="desktop-app">
This is a desktop application. Rules that hold for every stage:
- Business logic lives in core/ and imports nothing from the UI toolkit, so it is unit-tested without a window.
- Every IPC channel or command is declared in ONE contract file (ipc.ts for Electron, commands.rs for Tauri). The UI calls only what that file declares.
- Follow the toolkit's security model: Electron context isolation with a preload bridge; Tauri commands with capabilities.
- The packaging step produces a real installer or bundle as its artifact.
- Say plainly which layers the browser can check and which need the command line.
</profile_rules>`,
};
