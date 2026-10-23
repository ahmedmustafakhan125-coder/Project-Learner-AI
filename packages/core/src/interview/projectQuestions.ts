import type { ProjectTier } from '@ai-edu/llm';

import type { Profile, ProfileId } from '../profiles/types.js';
import { MAX_QUESTIONS } from '../schemas/interview.js';
import type { ChoiceOption, InterviewQuestion, OptionDetail, Slots } from '../schemas/interview.js';
import { PROFILE_CONFIDENCE_FLOOR, ScopeSignals, detectProfile, questionSlots } from './complexity.js';
import { rankMissingSlots, slotsFor } from './slots.js';
import type { SlotDef } from './slots.js';

/**
 * The project page's questions, written by code (PROJECT_LEARNER on).
 *
 * The workspace's questions are worded by the model on every request. For a
 * project that meant a different form each time, buttons that promised
 * "Specialist Answers", and a stack question that came back as a bare text box
 * — "Which languages, frameworks, or tech stack do you want to use?" — which a
 * beginner has no way to answer. Here each question has fixed wording and
 * fixed chips. Every stack option says what it is written in, how hard it is,
 * what it is best at and what the learner will understand by the end; one is
 * recommended, with the reason, and "choose for me" leaves it to the Stack
 * Brief. The model still reads the learner's message (classify); it no longer
 * writes the form, so the project page also makes one model call fewer.
 *
 * Two rounds. Round 1 (`projectQuestions`) runs before the tier is known and
 * asks the base slots. Round 2 (`scopeQuestions`) runs once intake has scored
 * the tier, and only a project big enough for a second round gets one: how
 * people use it, where its data lives, who signs in, and its profile's own
 * questions, within the tier's budget (invariant 18). The tier itself is never
 * shown to the learner.
 */

/**
 * The tech answer that leaves the choice to the Stack Brief. `namedTechnologies`
 * reads it as no preference, so the brief recommends a stack and explains it.
 */
export const RECOMMEND_STACK = 'Recommend one for me';

/** A stack a learner can pick, explained well enough to pick it without knowing it already. */
export interface StackChoice extends OptionDetail {
  /** What the learner picks. It splits into technologies the way `namedTechnologies` splits an answer. */
  name: string;
  /** Why this is the one to start with. Set on exactly one choice per kind. */
  why?: string;
}

const stack = (
  name: string,
  language: string,
  difficulty: OptionDetail['difficulty'],
  bestFor: string,
  learn: string,
  why?: string,
): StackChoice => ({ name, language, difficulty, bestFor, learn, ...(why ? { why } : {}) });

/** No kind known yet: languages, which fit any kind of project. */
const GENERIC_STACKS: StackChoice[] = [
  stack('Python', 'Python', 'easy', 'Almost anything: scripts, web servers, data', 'Clear code, functions and the standard library',
    'Readable, quick to set up, and it fits almost any kind of project.'),
  stack('JavaScript', 'JavaScript', 'easy', 'Anything that runs in a browser, and servers too', 'Functions, objects and asynchronous code'),
  stack('Java', 'Java', 'medium', 'Large programs and Android apps', 'Classes, types and object-oriented design'),
  stack('C#', 'C#', 'medium', 'Windows apps, and games in Unity', 'Classes, types and the .NET libraries'),
  stack('Go', 'Go', 'medium', 'Servers and command-line tools', 'Types, concurrency and simple design'),
  stack('Rust', 'Rust', 'hard', 'Fast programs without memory bugs', 'Ownership and the borrow checker'),
  stack('C++', 'C++', 'hard', 'Games, graphics and fast programs', 'Memory, pointers and classes'),
];

/**
 * The stacks people usually pick for each kind of software, explained. None
 * carries a version: versions come only from the dossier or the pin table
 * (invariant 22).
 */
export const STACKS_BY_PROFILE: Record<ProfileId, StackChoice[]> = {
  'web-frontend': [
    stack('Plain HTML, CSS and JavaScript', 'HTML, CSS and JavaScript', 'easy', 'Small sites and pages that mostly show information',
      'How the browser builds, styles and updates a page',
      'Nothing to install, and every framework is built on these three, so they are the best first step.'),
    stack('React', 'JavaScript (JSX)', 'medium', 'Interactive pages with many changing parts', 'Components, props and state'),
    stack('Vue', 'JavaScript', 'medium', 'Adding interactivity a piece at a time, up to a whole app', 'Templates, reactive data and components'),
    stack('Svelte', 'JavaScript', 'medium', 'Fast, light pages written with little code', 'Components and reactivity, with less boilerplate'),
  ],
  'web-fullstack': [
    stack('React + Node.js', 'JavaScript', 'medium', 'Apps with a page and a server you write yourself',
      'Components, REST APIs and how a page talks to its server',
      'One language, JavaScript, for both the page and the server, and the most help online.'),
    stack('Next.js', 'JavaScript or TypeScript', 'hard', 'Apps that need fast pages and good search ranking', 'Routing, server rendering and API routes in one framework'),
    stack('Python + Django', 'Python', 'medium', 'Data-heavy apps with accounts and an admin panel', 'Models, views, templates and a database'),
    stack('Ruby on Rails', 'Ruby', 'medium', 'Getting a complete app working quickly', 'Conventions, models and database migrations'),
  ],
  'api-backend': [
    stack('Python + FastAPI', 'Python', 'easy', 'Clean APIs that check their own inputs', 'Endpoints, data validation and automatic API docs',
      'Readable Python that checks every request for you and writes the API’s documentation as you code.'),
    stack('Node.js + Express', 'JavaScript', 'easy', 'Small, flexible APIs with few rules', 'Routes, middleware and JSON'),
    stack('Go', 'Go', 'medium', 'Fast services that handle many requests at once', 'Types, concurrency and the standard HTTP library'),
    stack('Java + Spring Boot', 'Java', 'hard', 'Large, structured services like those at big companies', 'Dependency injection, layers and strong typing'),
  ],
  'cli-tool': [
    stack('Python', 'Python', 'easy', 'Scripts and tools that automate everyday tasks', 'Arguments, files and the standard library',
      'Short, readable code, and its standard library already reads arguments and files.'),
    stack('Node.js', 'JavaScript', 'easy', 'Tools for web developers and npm users', 'Asynchronous code, packages and the file system'),
    stack('Go', 'Go', 'medium', 'One fast program you can copy to any computer', 'Types, errors as values and cross-compiling'),
    stack('Rust', 'Rust', 'hard', 'Very fast, very reliable tools', 'Ownership, error handling and the borrow checker'),
  ],
  'desktop-app': [
    stack('Tauri + Rust', 'Rust, with a web interface', 'medium', 'Small, fast apps with a web-style interface',
      'A web interface, a Rust core and how the two call each other',
      'You build the window with ordinary web code and only a little Rust, and the app stays small and fast.'),
    stack('Electron', 'JavaScript, HTML and CSS', 'easy', 'Apps built with web skills, like VS Code or Slack', 'Windows, menus and messages between processes'),
    stack('Python + Qt', 'Python', 'medium', 'Tools with native-looking windows and forms', 'Widgets, layouts and events'),
    stack('C# + .NET', 'C#', 'medium', 'Polished apps, especially on Windows', 'Strong typing, events and data binding'),
  ],
  'mobile-app': [
    stack('React Native', 'JavaScript', 'medium', 'One app for both iPhone and Android', 'Components, navigation and phone features',
      'One JavaScript codebase runs on iPhone and Android, and the skills carry over to the web.'),
    stack('Flutter', 'Dart', 'medium', 'Smooth, good-looking apps for both platforms', 'Widgets, layouts and state'),
    stack('Swift', 'Swift', 'medium', 'iPhone and iPad apps only; it needs a Mac', 'SwiftUI views and Apple’s frameworks'),
    stack('Kotlin', 'Kotlin', 'medium', 'Android apps only', 'Compose screens and how Android runs an app'),
  ],
  game: [
    stack('JavaScript + HTML canvas', 'JavaScript', 'easy', '2D games that run in the browser', 'The game loop, drawing and input',
      'It runs in your browser with nothing to install, and you write the game loop yourself, so you see how games work.'),
    stack('Python + Pygame', 'Python', 'easy', 'Simple 2D games on your computer', 'The game loop, sprites and collisions'),
    stack('Godot', 'GDScript, which reads like Python', 'medium', '2D and 3D games made in a full editor', 'Scenes, nodes and signals'),
    stack('Unity', 'C#', 'hard', '3D games and the tools studios use', 'Game objects, components and physics'),
  ],
  graphics: [
    stack('JavaScript + WebGL', 'JavaScript and GLSL', 'medium', '3D graphics that run in any browser', 'Shaders, buffers and the GPU pipeline',
      'It runs in any browser with no setup, and what you learn about shaders carries over to OpenGL and Vulkan.'),
    stack('C++ + OpenGL', 'C++ and GLSL', 'hard', 'Classic real-time 3D rendering', 'Shaders, buffers and the GPU pipeline'),
    stack('Rust + wgpu', 'Rust and WGSL', 'hard', 'Modern, safe graphics on any platform', 'Modern GPU APIs, shaders and pipelines'),
    stack('Python + NumPy', 'Python', 'easy', 'Ray tracers that write image files', 'Vectors, rays and how light is computed'),
  ],
  'systems-os': [
    stack('C', 'C', 'hard', 'Following the operating-system guides, which are mostly in C', 'Memory, pointers and driving hardware directly',
      'Nearly every OS-development guide and example is in C, so help is easy to find when you are stuck.'),
    stack('Rust', 'Rust', 'hard', 'A safer kernel, with a well-known online series to follow', 'Ownership, and unsafe code at the lowest level'),
    stack('Zig', 'Zig', 'hard', 'C-like control with modern conveniences', 'Manual memory, compile-time code and cross-compiling'),
  ],
  'language-tooling': [
    stack('Python', 'Python', 'easy', 'A first interpreter, written quickly', 'Scanning, parsing and evaluating code',
      'Quick to write, so your effort goes into the interpreter rather than the language you write it in.'),
    stack('JavaScript', 'JavaScript', 'easy', 'An interpreter that runs in the browser', 'Scanning, parsing and evaluating code'),
    stack('Rust', 'Rust', 'hard', 'A fast interpreter or compiler', 'Enums, pattern matching and control of memory'),
    stack('C', 'C', 'hard', 'A bytecode virtual machine with its own memory management', 'Memory layout, bytecode and garbage collection'),
  ],
  'systems-other': [
    stack('C', 'C', 'hard', 'Seeing exactly what the machine does', 'Pointers, memory and system calls',
      'Nothing is hidden: you see every byte and system call, which is the point of a systems project.'),
    stack('C++', 'C++', 'hard', 'Fast programs that still have high-level tools', 'Memory, RAII and templates'),
    stack('Rust', 'Rust', 'hard', 'Fast programs without memory bugs', 'Ownership, lifetimes and safe concurrency'),
    stack('Go', 'Go', 'medium', 'Networked tools and servers', 'Concurrency, interfaces and system calls'),
  ],
  'data-ml': [
    stack('Python + pandas', 'Python', 'easy', 'Loading, cleaning and charting data', 'Data frames, grouping and plotting',
      'The standard first tool for working with data, and later steps such as machine learning build on it.'),
    stack('Python + scikit-learn', 'Python', 'medium', 'Classic machine learning on tables of data', 'Training, testing and measuring models'),
    stack('Python + PyTorch', 'Python', 'hard', 'Neural networks and deep learning', 'Tensors, training loops and gradients'),
    stack('R', 'R', 'medium', 'Statistics and research-style analysis', 'Data frames, statistics and plots'),
  ],
  embedded: [
    stack('C + Arduino', 'C and C++', 'easy', 'Sensors, lights and motors on cheap boards', 'Pins, timing and reading sensors',
      'Cheap boards, a huge community, and a library for almost every sensor.'),
    stack('MicroPython', 'Python', 'easy', 'Quick experiments on small boards', 'Pins, sensors and a live prompt on the board'),
    stack('C + Pico SDK', 'C', 'medium', 'Raspberry Pi Pico projects with full control', 'Registers, interrupts and the build system'),
    stack('Rust', 'Rust', 'hard', 'Reliable firmware without memory bugs', 'Embedded Rust, ownership and hardware access'),
  ],
  general: GENERIC_STACKS,
};

/**
 * The kind-of-project chips. Each label scores to its profile under
 * `detectProfile`, so the chip a learner picks leads intake to the profile
 * whose stacks the stack question offered.
 */
export const PROJECT_KINDS: readonly { label: string; profile: ProfileId }[] = [
  { label: 'Website', profile: 'web-frontend' },
  { label: 'Web app', profile: 'web-fullstack' },
  { label: 'API / backend', profile: 'api-backend' },
  { label: 'Mobile app', profile: 'mobile-app' },
  { label: 'Desktop app', profile: 'desktop-app' },
  { label: 'Game', profile: 'game' },
  { label: 'CLI tool', profile: 'cli-tool' },
  { label: 'Data / ML', profile: 'data-ml' },
];

interface QuestionCopy {
  question: string;
  why: string;
  type?: InterviewQuestion['type'];
  placeholder?: string;
  options?: ChoiceOption[];
  allowOther?: boolean;
}

const option = (label: string, value = label, hint?: string): ChoiceOption => ({ label, value, ...(hint ? { hint } : {}) });

/**
 * Fixed wording per slot: the four base slots round 1 asks, then the tier and
 * profile slots round 2 asks. Option values are what the plan reads, and what
 * `answerSignals` turns into scope signals.
 */
const COPY: Record<string, QuestionCopy> = {
  /* ---------------- round 1: the base slots ---------------- */
  domain: {
    question: 'What kind of project is it?',
    why: 'This sets which parts it needs: a web app has pages and a server, a CLI tool runs in a terminal.',
    placeholder: 'Something else, e.g. a browser extension',
    options: PROJECT_KINDS.map((kind) => option(kind.label)),
  },
  tech: {
    question: 'What do you want to build it with?',
    why:
      'Your stack is the languages, frameworks and tools the project is built with. Each option says what it is written in, ' +
      'how hard it is, what it is best at and what you will learn.',
    placeholder: 'Or name your own, e.g. Vue and Firebase',
  },
  skill_level: {
    question: 'How much programming have you done?',
    why: 'This sets how much each step explains.',
    options: [option('Beginner', 'beginner'), option('Intermediate', 'intermediate'), option('Advanced', 'advanced')],
    // The plan reads one of these three values.
    allowOther: false,
  },
  time_budget: {
    question: 'How much time can you give it in total?',
    why: 'This sets how big the project is, so it is one you can finish.',
    placeholder: 'e.g. 15 hours',
    // Values `parseTimeBudget` reads as 4, 10, 25 and 40 hours.
    options: [option('A few hours'), option('About 10 hours', '~10 hours'), option('About 25 hours', '~25 hours'), option('40+ hours')],
  },

  /* ---------------- round 2: the tier slots ---------------- */
  interface: {
    question: 'Where will people use it?',
    why: 'Each place is a front end of its own to build. Pick every one that applies.',
    type: 'multi',
    placeholder: 'Somewhere else',
    options: [
      option('In a web browser', 'Web page'),
      option('On a phone', 'Phone app'),
      option('In a desktop window', 'Desktop window'),
      option('In a terminal', 'Command line'),
      option('From other programs, through an API', 'API'),
    ],
  },
  data: {
    question: 'What does it need to remember?',
    why: 'Saving data adds a storage layer: files are the simplest, a server database the most work.',
    options: [
      option('Nothing', 'Nothing', 'It starts fresh every time.'),
      option('Files', 'Files', 'Saved on the computer it runs on.'),
      option('A database on the device', 'Local database', 'Such as SQLite or the browser’s own storage.'),
      option('A database on a server', 'Server database', 'Shared by everyone who uses it, such as Postgres.'),
    ],
    allowOther: false,
  },
  users_auth: {
    question: 'Who signs in?',
    why: 'Sign-in means accounts, passwords and keeping each person’s data apart: a large part of the work.',
    options: [
      option('No one', 'Just me', 'Anyone who opens it can use it.'),
      option('Each person, to their own account', 'Accounts with sign-in', 'Everyone sees only their own data.'),
      option('Different kinds of users', 'Several roles', 'Such as admins and members, each allowed different things.'),
    ],
    allowOther: false,
  },
  integrations: {
    question: 'Does it use any outside services?',
    why: 'Each one is an account to set up and an API to learn. Pick every one that applies.',
    type: 'multi',
    placeholder: 'Another service, e.g. a weather API',
    options: [option('None'), option('Payments'), option('Email'), option('Maps'), option('An AI model')],
  },
  deploy_target: {
    question: 'Where should the finished project run?',
    why: 'This sets the last steps. Your own computer is free and simple; a server needs hosting set up.',
    options: [
      option('Just on my computer', 'My machine', 'Free, with nothing to set up.'),
      option('A static host', 'Static host', 'Free hosting for sites with no server.'),
      option('A server online', 'A server', 'Hosting to set up, sometimes paid.'),
      option('An app store', 'An app store', 'A developer account and a review first.'),
    ],
  },
  scale_nfr: {
    question: 'Does it need to handle anything demanding?',
    why: 'Targets like many people at once or fast responses change how it is designed.',
    type: 'multi',
    options: [option('Nothing special'), option('Many people at once'), option('Lots of data'), option('Fast responses')],
  },
  architecture_pref: {
    question: 'Is there a design you want to practise?',
    why: 'The plan can be built around one, so you learn it on a real project.',
    options: [option('No preference'), option('Clean layers'), option('Separate services'), option('A plugin system')],
  },
  testing_depth: {
    question: 'How much testing do you want to learn?',
    why: 'Tests are extra steps, but they catch mistakes and are what employers look for.',
    options: [option('Basic checks'), option('Thorough unit tests'), option('Unit and integration tests', 'Unit plus integration')],
    allowOther: false,
  },

  /* ---------------- round 2: profile slots ---------------- */
  target_os: {
    question: 'Which computers must it run on?',
    why: 'Each system has its own packaging and quirks to handle. Pick every one that applies.',
    type: 'multi',
    options: [option('Windows'), option('macOS'), option('Linux')],
    allowOther: false,
  },
  offline_data: {
    question: 'What does it keep on the computer?',
    why: 'Saved data adds a storage layer to build.',
    options: [option('Nothing'), option('Settings only'), option('Files the user opens'), option('A local database')],
    allowOther: false,
  },
  os_integration: {
    question: 'Does it hook into the system?',
    why: 'Each one is a platform feature to wire up. Pick every one that applies.',
    type: 'multi',
    options: [option('Tray icon'), option('Notifications'), option('Files'), option('Global shortcuts'), option('None')],
  },
  distribution: {
    question: 'How will people get it?',
    why: 'Shipping an app is steps of its own: installers, signing and updates.',
    options: [option('An installer', 'Installer'), option('An app store', 'App store'), option('With auto-update', 'Auto-update'), option('Just run it locally')],
  },
  target_arch: {
    question: 'Which CPU should the kernel run on?',
    why: 'Boot code and assembly differ by CPU. Every choice runs in an emulator, so you need no extra hardware.',
    options: [option('x86-64', 'x86-64', 'The most guides to follow.'), option('RISC-V', 'RISC-V', 'Small and clean, and newer.'), option('AArch64', 'AArch64', 'The CPU in phones and newer Macs.')],
  },
  host_os: {
    question: 'Which system do you develop on?',
    why: 'Setting up the cross-compiler and emulator differs by system.',
    options: [option('Linux'), option('macOS'), option('Windows, with WSL 2', 'Windows (WSL 2)')],
  },
  boot_path: {
    question: 'How should the kernel be loaded?',
    why: 'The bootloader hands control to your kernel. Limine does the most for you.',
    options: [
      option('Limine', 'Limine', 'Does the most for you.'),
      option('GRUB with Multiboot2', 'GRUB + Multiboot2', 'The loader most older guides use.'),
      option('UEFI', 'UEFI', 'The firmware of modern PCs; more to set up.'),
      option('My own bootloader', 'My own bootloader', 'A project in itself.'),
    ],
  },
  os_depth: {
    question: 'How far do you want to go?',
    why: 'Each stage builds on the last, and going further adds milestones.',
    options: [option('Boot and print'), option('Interrupts and memory'), option('Multitasking'), option('Userspace and a shell')],
  },
  source_language: {
    question: 'Which language will you implement?',
    why: 'An existing language comes with its rules written down; your own means designing them first.',
    options: [
      option('Lox', 'Lox', 'A small language with a free book that builds it step by step.'),
      option('A Lisp', 'A Lisp', 'Tiny syntax, so parsing is quick.'),
      option('A C subset', 'A C subset', 'Familiar syntax, with real types.'),
      option('My own language', 'My own language', 'You design its rules first.'),
    ],
  },
  lang_target: {
    question: 'What should it produce?',
    why: 'This sets how deep the project goes.',
    options: [
      option('A tree-walking interpreter', 'Tree-walking interpreter', 'The gentlest start.'),
      option('A bytecode VM', 'Bytecode VM', 'Faster, and closer to how real languages run.'),
      option('WebAssembly', 'WebAssembly', 'Code that runs in the browser.'),
      option('Native code', 'Native code', 'The deepest.'),
    ],
  },
  lang_features: {
    question: 'Which features should your language have?',
    why: 'Each one is a step or more of its own. Pick every one that applies.',
    type: 'multi',
    options: [option('Functions'), option('Closures'), option('Classes'), option('Garbage collection'), option('Static types')],
  },
};

/* ------------------------------------------------------------------ *
 * Round 1
 * ------------------------------------------------------------------ */

/** The stack options, the recommended one first and "choose for me" last. */
function stackOptions(choices: readonly StackChoice[]): ChoiceOption[] {
  const ordered = [...choices.filter((c) => c.why), ...choices.filter((c) => !c.why)];
  return [
    ...ordered.map(({ name, why, ...detail }) => ({ label: name, value: name, detail, ...(why ? { recommended: why } : {}) })),
    option(
      'Not sure — choose for me',
      RECOMMEND_STACK,
      'The plan picks a stack that fits your project and experience, then explains every part, with its alternatives, for you to approve.',
    ),
  ];
}

/**
 * The profile the message's own words point to, or null when they do not
 * point clearly. The stack is left out: it says what the software is built
 * with, not what it is, and "React" leaning to a front end must not make a
 * web app read as unsure.
 */
function confidentProfile(rawQuery: string, slots: Slots): ProfileId | null {
  const described: Slots = Object.fromEntries(Object.entries(slots).filter(([key]) => key !== 'tech'));
  const said = described['domain']?.value?.trim() || rawQuery;
  const detection = detectProfile(ScopeSignals.parse({ domainWords: [said] }), described);
  if (detection.profile === 'general' || detection.confidence < PROFILE_CONFIDENCE_FLOOR) return null;
  return detection.profile;
}

/**
 * The message names a kind of project, but too vaguely to plan ("a recipe
 * organiser"). The project page then asks the kind as well (§5: below the
 * confidence floor, one question goes on "Which is closest?"), since the
 * learner no longer sees a profile chip to correct.
 */
export function unsureKind(rawQuery: string, slots: Slots): boolean {
  return Boolean(slots['domain']?.value?.trim()) && confidentProfile(rawQuery, slots) === null;
}

function stackQuestion(rawQuery: string, slots: Slots, kindAskedToo: boolean): InterviewQuestion {
  const copy = COPY['tech']!;
  const profile = confidentProfile(rawQuery, slots);
  return {
    slot: 'tech',
    question: copy.question,
    why: copy.why,
    type: 'single',
    options: stackOptions(profile ? STACKS_BY_PROFILE[profile] : GENERIC_STACKS),
    allowOther: true,
    ...(copy.placeholder ? { placeholder: copy.placeholder } : {}),
    // Asked in the same round, the kind decides the options as soon as it is picked.
    ...(kindAskedToo
      ? {
          follows: {
            slot: 'domain',
            options: Object.fromEntries(PROJECT_KINDS.map((kind) => [kind.label, stackOptions(STACKS_BY_PROFILE[kind.profile])])),
          },
        }
      : {}),
  };
}

function slotQuestion(def: SlotDef): InterviewQuestion {
  const copy = COPY[def.key];
  const options = copy?.options ?? (def.suggestedOptions ?? []).map((value) => option(value));
  return {
    slot: def.key,
    question: copy?.question ?? `${def.label}?`,
    why: copy?.why ?? def.description,
    type: options.length ? (copy?.type ?? 'single') : 'text',
    options,
    allowOther: copy?.allowOther ?? true,
    ...(copy?.placeholder ? { placeholder: copy.placeholder } : {}),
  };
}

export interface ProjectQuestionsInput {
  rawQuery: string;
  slots: Slots;
  /** Slot keys to ask: the unfilled ones from `scoreSufficiency`, and `domain` when `unsureKind`. */
  missing: string[];
}

/**
 * One question per missing project slot, most important first: the kind of
 * project, the stack, experience, then time. Pure: the same request always
 * gets the same form.
 */
export function projectQuestions({ rawQuery, slots, missing }: ProjectQuestionsInput): InterviewQuestion[] {
  const wanted = rankMissingSlots('project_generation', missing).slice(0, MAX_QUESTIONS);
  const kindAskedToo = wanted.some((def) => def.key === 'domain');
  return wanted.map((def) => (def.key === 'tech' ? stackQuestion(rawQuery, slots, kindAskedToo) : slotQuestion(def)));
}

/* ------------------------------------------------------------------ *
 * Round 2
 * ------------------------------------------------------------------ */

/** Round 1's slots. Round 2 never asks them again, answered or skipped. */
const ROUND_ONE_SLOTS = slotsFor('project_generation').map((s) => s.key);

/**
 * Slots the stack answer already settles: the language a kernel or an
 * interpreter is written in, and how an interface is built. Asking them after
 * the stack question asks the same thing twice.
 */
const SETTLED_BY_STACK = ['kernel_language', 'impl_language', 'ui_tech', 'frontend_pref'];

/**
 * The kinds of software each app-shaped tier slot fits. A kernel has no
 * sign-in page, and a phone app is used on a phone. Slots not listed fit every kind.
 */
const FITS: Partial<Record<string, readonly ProfileId[]>> = {
  interface: ['web-fullstack', 'api-backend', 'data-ml', 'general'],
  data: ['web-frontend', 'web-fullstack', 'api-backend', 'mobile-app', 'cli-tool', 'game', 'general'],
  users_auth: ['web-fullstack', 'api-backend', 'mobile-app', 'general'],
  integrations: ['web-frontend', 'web-fullstack', 'api-backend', 'mobile-app', 'desktop-app', 'cli-tool', 'general'],
  deploy_target: ['web-frontend', 'web-fullstack', 'api-backend', 'cli-tool', 'game', 'general'],
  scale_nfr: ['web-fullstack', 'api-backend', 'data-ml', 'systems-other', 'general'],
};

/** Slots the message already answered through its scope signals. */
function settledBySignals(signals: ScopeSignals): string[] {
  const settled: string[] = [];
  if (signals.interfaces.length) settled.push('interface');
  if (signals.persistence) settled.push('data', 'offline_data');
  if (signals.accounts !== undefined || signals.multiUser !== undefined) settled.push('users_auth');
  if (signals.externalApis !== undefined || signals.payments !== undefined) settled.push('integrations');
  if (signals.targetArch) settled.push('target_arch');
  return settled;
}

export interface ScopeQuestionsInput {
  tier: ProjectTier;
  profile: Profile;
  slots: Slots;
  signals: ScopeSignals;
}

/**
 * Round 2: what a project of this tier and kind still needs to know, once
 * intake has scored it. `questionSlots` sets the budget (invariant 18), so a
 * tier with one round gets none and the rest get at most its questions per
 * round; this only takes out what would be asked twice or makes no sense for
 * the kind of software. Pure, like round 1.
 */
export function scopeQuestions({ tier, profile, slots, signals }: ScopeQuestionsInput): InterviewQuestion[] {
  const unfit = Object.entries(FITS)
    .filter(([, kinds]) => !kinds!.includes(profile.id))
    .map(([key]) => key);
  const askedSlots = [...ROUND_ONE_SLOTS, ...SETTLED_BY_STACK, ...unfit, ...settledBySignals(signals)];
  return questionSlots({ tier, profile, slots, round: 1, askedSlots }).map(slotQuestion);
}

const INTERFACE_SIGNAL: Record<string, string> = {
  'Web page': 'web',
  'Phone app': 'mobile',
  'Desktop window': 'desktop',
  'Command line': 'cli',
  API: 'api',
};

const PERSISTENCE: Record<string, NonNullable<ScopeSignals['persistence']>> = {
  Nothing: 'none',
  Files: 'files',
  'Local database': 'embedded-db',
  'Server database': 'server-db',
  'Settings only': 'files',
  'Files the user opens': 'files',
  'A local database': 'embedded-db',
};

/** A multi-choice answer as the page sends it: the picked values, joined by ", ". */
const picks = (answer: string | undefined) =>
  (answer ?? '')
    .split(', ')
    .map((v) => v.trim())
    .filter(Boolean);

/**
 * Round 2's answers as scope signals, so the tier is scored again from what
 * the learner said rather than what the message implied. An answer replaces
 * the signal it speaks to; anything it does not speak to is kept.
 */
export function answerSignals(signals: ScopeSignals, answers: Record<string, string>): ScopeSignals {
  const next: ScopeSignals = { ...signals, domainWords: [...signals.domainWords], interfaces: [...signals.interfaces] };

  const interfaces = picks(answers['interface']).flatMap((v) => (INTERFACE_SIGNAL[v] ? [INTERFACE_SIGNAL[v]] : []));
  if (interfaces.length) next.interfaces = [...new Set(interfaces)];

  const persistence = PERSISTENCE[answers['data']?.trim() ?? ''] ?? PERSISTENCE[answers['offline_data']?.trim() ?? ''];
  if (persistence) next.persistence = persistence;

  const users = answers['users_auth']?.trim();
  if (users === 'Just me') Object.assign(next, { accounts: false, multiUser: false });
  if (users === 'Accounts with sign-in') next.accounts = true;
  if (users === 'Several roles') Object.assign(next, { accounts: true, multiUser: true });

  const services = picks(answers['integrations']);
  if (services.length) {
    const used = services.filter((s) => s !== 'None');
    next.payments = used.includes('Payments');
    next.externalApis = used.some((s) => s !== 'Payments');
  }
  return next;
}
