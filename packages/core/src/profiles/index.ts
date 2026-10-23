import { apiBackend } from './api-backend.js';
import { cliTool } from './cli-tool.js';
import { dataMl } from './data-ml.js';
import { desktopApp } from './desktop-app.js';
import { embedded } from './embedded.js';
import { game } from './game.js';
import { general } from './general.js';
import { graphics } from './graphics.js';
import { languageTooling } from './language-tooling.js';
import { mobileApp } from './mobile-app.js';
import { systemsOs } from './systems-os.js';
import { systemsOther } from './systems-other.js';
import type { LayerDef, Profile, ProfileId } from './types.js';
import { webFrontend } from './web-frontend.js';
import { webFullstack } from './web-fullstack.js';

/** Every profile, by id (docs/project-learner.md §6). Pure data. */
export const PROFILES: Record<ProfileId, Profile> = {
  'web-frontend': webFrontend,
  'web-fullstack': webFullstack,
  'api-backend': apiBackend,
  'cli-tool': cliTool,
  'desktop-app': desktopApp,
  'mobile-app': mobileApp,
  game,
  graphics,
  'systems-os': systemsOs,
  'language-tooling': languageTooling,
  'systems-other': systemsOther,
  'data-ml': dataMl,
  embedded,
  general,
};

export function getProfile(id: ProfileId): Profile {
  return PROFILES[id];
}

export function layerDef(profile: Profile, layerId: string): LayerDef | undefined {
  return profile.layers.find((l) => l.id === layerId);
}
