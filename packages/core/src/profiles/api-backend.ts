import { basicProfile } from './basic.js';

export const apiBackend = basicProfile({
  id: 'api-backend',
  label: 'API or backend service',
  signalWords: [
    'api', 'rest api', 'rest', 'graphql', 'backend', 'back end', 'server', 'microservice',
    'endpoint', 'express', 'fastapi', 'flask', 'fastify', 'webhook',
  ],
  layers: [
    ['runtime', 'Runtime', 'Foundation', 'The language and runtime the service runs on.'],
    ['framework', 'Framework', 'Server', 'What routes requests to handlers.'],
    ['database', 'Database', 'Data', 'Where the data lives.'],
    ['auth', 'Auth', 'Server', 'Who may call what.'],
    ['api-spec', 'API description', 'Server', 'The OpenAPI or GraphQL schema that describes it.'],
    ['testing', 'Testing', 'Quality', 'Unit tests on services and integration tests on routes.'],
    ['hosting', 'Hosting', 'Ship', 'Where the service runs.'],
  ],
  requiredLayersByTier: {
    T1: ['runtime', 'framework'],
    T2: ['runtime', 'framework', 'database'],
    T3: ['runtime', 'framework', 'database', 'auth', 'api-spec', 'testing'],
    T4: ['runtime', 'framework', 'database', 'auth', 'api-spec', 'testing', 'hosting'],
    T5: ['runtime', 'framework', 'database', 'auth', 'api-spec', 'testing', 'hosting'],
  },
  rule: 'Handlers stay thin and call pure services.',
  harnesses: ['unit'],
});
