import type { Profile } from './types.js';

/**
 * The fallback (docs/project-learner.md §6): audio DSP, robotics simulation,
 * bioinformatics, anything no other profile fits.
 *
 * Its layers are discovered by the research pass, so `verifyStackBrief` takes
 * any layer name here, and its documentation domains are not known in
 * advance: research runs with a blocked list instead of an allowlist, and
 * every reference it finds is unvetted.
 */

export const general: Profile = {
  id: 'general',
  label: 'General',
  deep: true,
  signalWords: [],
  layers: [
    { id: 'language', label: 'Language', section: 'Foundation', description: 'The main programming language.', research: 'general-domain' },
    {
      id: 'core-library',
      label: 'Core library',
      section: 'Foundation',
      description: "The domain's standard library or framework, found by research.",
      research: 'general-domain',
    },
    { id: 'testing', label: 'Testing', section: 'Quality', description: 'How the project is tested.', research: 'general-domain' },
    { id: 'packaging', label: 'Packaging', section: 'Ship', description: 'How the finished project is run or shared.', research: 'general-domain' },
  ],
  requiredLayersByTier: {
    T1: ['language'],
    T2: ['language', 'testing'],
    T3: ['language', 'core-library', 'testing', 'packaging'],
    T4: ['language', 'core-library', 'testing', 'packaging'],
    T5: ['language', 'core-library', 'testing', 'packaging'],
  },
  slots: [],
  tierFloors: [],
  architectureRule: {
    description: 'The plan names its test strategy, and pure logic is kept apart from input and output so it can be tested.',
    requiredPaths: ['tests/**|test/**|**/*_test.*|**/*.test.*|**/test_*'],
    firstStepCreates: [],
    forbiddenImports: [],
  },
  harnesses: ['unit'],
  browserRunnable: (brief) => {
    const language = brief.layers.find((l) => l.layer === 'language');
    return /\bpython\b|\bjavascript\b/.test((language?.name ?? '').toLowerCase());
  },
  toolchain: [],
  docSources: [{ key: 'base' }, { key: 'profile:general' }],
  prerequisites: [],
  promptAddendum: `<profile_rules profile="general">
No fixed profile fits this project, so its layers come from the research notes.
- Name the test strategy explicitly, and keep pure logic apart from input and output so it can be tested.
- References found for this project are unvetted: say so when relying on one, and prefer official documentation.
</profile_rules>`,
};
