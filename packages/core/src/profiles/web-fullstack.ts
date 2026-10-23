import { basicProfile } from './basic.js';

export const webFullstack = basicProfile({
  id: 'web-fullstack',
  label: 'Full-stack web app',
  signalWords: [
    'web app', 'webapp', 'saas', 'full stack', 'fullstack', 'full-stack', 'next.js', 'nextjs',
    'django', 'rails', 'laravel', 'dashboard',
  ],
  layers: [
    ['frontend', 'Front end', 'Interface', 'What renders the pages the user sees.'],
    ['backend', 'Back end', 'Server', 'The server process that answers requests.'],
    ['api', 'API', 'Server', 'The contract between front end and back end.'],
    ['database', 'Database', 'Data', 'Where the data lives.'],
    ['orm', 'ORM or query layer', 'Data', 'How the server talks to the database.'],
    ['auth', 'Auth', 'Server', 'Sign-in, sessions and who may do what.'],
    ['hosting', 'Hosting', 'Ship', 'Where the app runs in production.'],
    ['testing', 'Testing', 'Quality', 'Unit, route and table contract tests.'],
  ],
  requiredLayersByTier: {
    T1: ['frontend', 'backend'],
    T2: ['frontend', 'backend', 'database'],
    T3: ['frontend', 'backend', 'api', 'database', 'auth', 'hosting'],
    T4: ['frontend', 'backend', 'api', 'database', 'orm', 'auth', 'hosting', 'testing'],
    T5: ['frontend', 'backend', 'api', 'database', 'orm', 'auth', 'hosting', 'testing'],
  },
  tierFloors: [{ goal: 'A web app with a server and a database', tier: 'T2', keywords: [] }],
  rule: 'The API contract is declared before its handlers.',
  harnesses: ['unit'],
});
