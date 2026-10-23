import { basicProfile } from './basic.js';

export const webFrontend = basicProfile({
  id: 'web-frontend',
  label: 'Web front end',
  signalWords: [
    'website', 'web page', 'webpage', 'landing page', 'portfolio site', 'spa', 'single page app',
    'react', 'vue', 'svelte', 'html', 'css', 'frontend', 'front end', 'static site', 'kanban',
  ],
  layers: [
    ['ui-framework', 'UI framework', 'Interface', 'What renders the page: plain DOM, React, Vue or Svelte.'],
    ['styling', 'Styling', 'Interface', 'How it looks: plain CSS, a utility framework or components.'],
    ['state', 'State', 'Data', 'Where the data on screen lives and how it changes.'],
    ['routing', 'Routing', 'Interface', 'How URLs map to screens.'],
    ['build-tool', 'Build tool', 'Tooling', 'What bundles and serves the code in development.'],
    ['hosting', 'Hosting', 'Ship', 'Where the finished site is served from.'],
    ['testing', 'Testing', 'Tooling', 'Unit tests on the state logic.'],
  ],
  requiredLayersByTier: {
    T1: ['ui-framework'],
    T2: ['ui-framework', 'styling', 'state'],
    T3: ['ui-framework', 'styling', 'state', 'routing', 'build-tool', 'hosting'],
    T4: ['ui-framework', 'styling', 'state', 'routing', 'build-tool', 'hosting', 'testing'],
    T5: ['ui-framework', 'styling', 'state', 'routing', 'build-tool', 'hosting', 'testing'],
  },
  tierFloors: [{ goal: 'A front end that keeps its data', tier: 'T2', keywords: ['signal:persistence'] }],
  rule: 'State logic lives in plain modules, separate from the components.',
  harnesses: ['unit'],
  browser: true,
});
