import type { ProfileId } from '../../src/profiles/types.js';
import type { ScopeSignals } from '../../src/interview/complexity.js';
import type { ComplexityTier } from '../../src/schemas/stack.js';

/**
 * Scoring goldens (docs/project-learner.md §5 and §14, `complexity.goldens`).
 *
 * Each case is what the Gemini classify call would extract from the request,
 * and the profile and tier the deterministic scorer must give it. The cut
 * points and floors are tuned against these; a change that moves one of them
 * is a scoring change and needs a reason in the diff.
 *
 * Drafted in phase 2 with no phase 0 drafts to start from. Review by hand.
 */

export interface ScopingGolden {
  request: string;
  signals: Partial<ScopeSignals>;
  slots: Record<string, string>;
  profile: ProfileId;
  tier: ComplexityTier;
  /** True when the profile floor is above what the learner's time allows. */
  overTime?: boolean;
  /** Substrings that must appear among the reasons. */
  reasons?: string[];
}

export const SCOPING_GOLDENS: ScopingGolden[] = [
  {
    request: 'A Python CLI that renames photos by date, a few hours',
    signals: { domainWords: ['cli', 'renames photos'], interfaces: ['cli'] },
    slots: { domain: 'CLI tool that renames photos by date', tech: 'Python', time_budget: 'a few hours' },
    profile: 'cli-tool',
    tier: 'T1',
  },
  {
    request: 'I want to build an operating system',
    signals: { domainWords: ['operating system'], bareMetal: true },
    slots: { domain: 'operating system' },
    profile: 'systems-os',
    tier: 'T5',
    reasons: ['bare metal +4'],
  },
  {
    request: 'A Lox interpreter in Python',
    signals: { domainWords: ['interpreter', 'lox'] },
    slots: { domain: 'Lox interpreter', tech: 'Python' },
    profile: 'language-tooling',
    tier: 'T2',
    reasons: ['A tree-walking interpreter'],
  },
  {
    request: 'A Tauri notes app',
    signals: { domainWords: ['notes app', 'desktop'], interfaces: ['desktop'], persistence: 'embedded-db', nativeBuild: true },
    slots: { domain: 'notes app', tech: 'Tauri' },
    profile: 'desktop-app',
    tier: 'T3',
    reasons: ['embedded database +1', 'native build +1'],
  },
  {
    request: "Build a REST API in Express, I'm intermediate, about 10 hours",
    signals: { domainWords: ['rest api'], interfaces: ['api'] },
    slots: { domain: 'REST API', tech: 'Express', skill_level: 'intermediate', time_budget: 'about 10 hours' },
    profile: 'api-backend',
    tier: 'T1',
  },
  {
    request: 'A kanban SPA in React that saves to local storage',
    signals: { domainWords: ['kanban', 'spa'], interfaces: ['web'], persistence: 'files' },
    slots: { domain: 'kanban SPA', tech: 'React' },
    profile: 'web-frontend',
    tier: 'T2',
  },
  {
    request: 'A SaaS app with accounts, Stripe payments and a Postgres database, deployed',
    signals: {
      domainWords: ['saas'],
      interfaces: ['web'],
      persistence: 'server-db',
      accounts: true,
      payments: true,
      externalApis: true,
      deployment: true,
    },
    slots: { domain: 'SaaS app', tech: 'Next.js, Postgres, Stripe' },
    profile: 'web-fullstack',
    tier: 'T3',
    reasons: ['server database +2', 'accounts +2', 'payments +2'],
  },
  {
    request: 'A realtime chat web app with accounts, an API and background jobs',
    signals: {
      domainWords: ['chat', 'web app'],
      interfaces: ['web', 'api'],
      persistence: 'server-db',
      accounts: true,
      realtime: true,
      backgroundJobs: true,
    },
    slots: { domain: 'realtime chat web app' },
    profile: 'web-fullstack',
    tier: 'T4',
    reasons: ['extra interface +1', 'realtime +2', 'background jobs +2'],
  },
  {
    request: 'A Godot platformer with levels and saves',
    signals: { domainWords: ['platformer', 'levels', 'saves'], persistence: 'files' },
    slots: { domain: 'platformer game with levels and saves', tech: 'Godot' },
    profile: 'game',
    tier: 'T3',
  },
  {
    request: 'Pong on a canvas',
    signals: { domainWords: ['pong', 'game'], interfaces: ['web'] },
    slots: { domain: 'Pong game', tech: 'JavaScript canvas' },
    profile: 'game',
    tier: 'T1',
  },
  {
    request: 'A CPU ray tracer in Python that writes PNG files',
    signals: { domainWords: ['ray tracer'] },
    slots: { domain: 'CPU ray tracer', tech: 'Python' },
    profile: 'graphics',
    tier: 'T2',
  },
  {
    request: 'A Vulkan renderer in C++',
    signals: { domainWords: ['vulkan', 'renderer'], gpu: true, nativeBuild: true },
    slots: { domain: 'Vulkan renderer', tech: 'C++, Vulkan' },
    profile: 'graphics',
    tier: 'T4',
    reasons: ['GPU +2'],
  },
  {
    request: 'A CHIP-8 emulator in JavaScript',
    signals: { domainWords: ['chip-8', 'emulator'] },
    slots: { domain: 'CHIP-8 emulator', tech: 'JavaScript' },
    profile: 'systems-other',
    tier: 'T2',
  },
  {
    request: 'A NES emulator in Rust',
    signals: { domainWords: ['nes', 'emulator'], nativeBuild: true },
    slots: { domain: 'NES emulator', tech: 'Rust' },
    profile: 'systems-other',
    tier: 'T4',
  },
  {
    request: 'An x86-64 kernel in Rust that boots to a shell',
    signals: { domainWords: ['kernel', 'shell'], bareMetal: true, nativeBuild: true, targetArch: 'x86-64' },
    slots: { domain: 'kernel that boots to a shell', tech: 'Rust', target_arch: 'x86-64' },
    profile: 'systems-os',
    tier: 'T5',
  },
  {
    request: 'A hobby kernel that boots and prints hello over serial',
    signals: { domainWords: ['kernel', 'boots'], bareMetal: true },
    slots: { domain: 'kernel that boots and prints over serial' },
    profile: 'systems-os',
    tier: 'T4',
    reasons: ['A kernel that boots and prints'],
  },
  {
    request: 'A Pico weather station with a sensor and a small display',
    signals: { domainWords: ['weather station', 'sensor'], bareMetal: true },
    slots: { domain: 'weather station', tech: 'Raspberry Pi Pico' },
    profile: 'embedded',
    tier: 'T2',
  },
  {
    request: 'A small iris classifier in Python with scikit-learn',
    signals: { domainWords: ['classifier'] },
    slots: { domain: 'iris flower classifier', tech: 'Python, scikit-learn' },
    profile: 'data-ml',
    tier: 'T1',
  },
  {
    request: 'An ETL pipeline that pulls from an API into SQLite every night',
    signals: { domainWords: ['etl'], persistence: 'embedded-db', externalApis: true, backgroundJobs: true },
    slots: { domain: 'ETL pipeline', tech: 'Python, SQLite' },
    profile: 'data-ml',
    tier: 'T2',
  },
  {
    request: 'A habit tracker app for my phone',
    signals: { domainWords: ['habit tracker', 'phone'], interfaces: ['mobile'], persistence: 'embedded-db' },
    slots: { domain: 'habit tracker for my phone' },
    profile: 'mobile-app',
    tier: 'T2',
  },
  {
    request: 'A portfolio website',
    signals: { domainWords: ['website'], interfaces: ['web'] },
    slots: { domain: 'portfolio website' },
    profile: 'web-frontend',
    tier: 'T1',
  },
  {
    request: 'An audio synthesizer DSP library in Rust',
    signals: { domainWords: ['audio', 'synthesizer', 'dsp'], nativeBuild: true },
    slots: { domain: 'audio DSP library', tech: 'Rust' },
    profile: 'general',
    tier: 'T1',
  },
  {
    request: 'A Lisp interpreter with a bytecode VM and a garbage collector in C',
    signals: { domainWords: ['lisp', 'interpreter', 'bytecode vm', 'garbage collector'], nativeBuild: true },
    slots: { domain: 'Lisp interpreter with a bytecode VM', tech: 'C' },
    profile: 'language-tooling',
    tier: 'T4',
  },
  {
    request: 'A toy C compiler to x86-64 assembly',
    signals: { domainWords: ['compiler', 'x86-64', 'assembly'], nativeBuild: true },
    slots: { domain: 'C compiler to x86-64 assembly' },
    profile: 'language-tooling',
    tier: 'T5',
  },
  {
    request: 'A Tauri notes app, I have about 10 hours',
    signals: { domainWords: ['notes app', 'desktop'], interfaces: ['desktop'], persistence: 'embedded-db', nativeBuild: true },
    slots: { domain: 'notes app', tech: 'Tauri', time_budget: 'about 10 hours' },
    profile: 'desktop-app',
    tier: 'T3',
    overTime: true,
  },
  {
    request: 'I want to build an operating system, I have a weekend',
    signals: { domainWords: ['operating system'], bareMetal: true },
    slots: { domain: 'operating system', time_budget: 'a weekend' },
    profile: 'systems-os',
    tier: 'T5',
    overTime: true,
  },
  {
    request: 'An Electron tray utility that shows CPU usage',
    signals: { domainWords: ['tray utility'], interfaces: ['desktop'] },
    slots: { domain: 'tray utility', tech: 'Electron' },
    profile: 'desktop-app',
    tier: 'T2',
  },
  {
    request: 'A key-value store with a write-ahead log in Go',
    signals: { domainWords: ['key-value store', 'write-ahead log'], persistence: 'files', nativeBuild: true },
    slots: { domain: 'key-value store', tech: 'Go' },
    profile: 'systems-other',
    tier: 'T2',
  },
  {
    request: 'A Flask API with SQLite and login, deployed to Fly',
    signals: { domainWords: ['api'], interfaces: ['api'], persistence: 'embedded-db', accounts: true, deployment: true },
    slots: { domain: 'API with login', tech: 'Flask, SQLite' },
    profile: 'api-backend',
    tier: 'T2',
  },
  {
    request: 'A multiplayer browser Pong over websockets',
    signals: { domainWords: ['pong', 'multiplayer'], interfaces: ['web'], realtime: true },
    slots: { domain: 'multiplayer Pong', tech: 'JavaScript, WebSockets' },
    profile: 'game',
    tier: 'T4',
  },
  {
    request: 'A game engine in C++ with an ECS and an editor',
    signals: { domainWords: ['game engine', 'ecs', 'editor'], gpu: true, nativeBuild: true },
    slots: { domain: 'game engine', tech: 'C++' },
    profile: 'game',
    tier: 'T5',
  },
  {
    request: 'A Python CLI to back up a folder, about 25 hours',
    signals: { domainWords: ['cli', 'backup'], interfaces: ['cli'], persistence: 'files' },
    slots: { domain: 'CLI backup tool', tech: 'Python', time_budget: '~25 hours' },
    profile: 'cli-tool',
    tier: 'T1',
  },
];
