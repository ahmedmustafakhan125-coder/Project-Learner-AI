import type { ArchitectureRule, HarnessKind, LayerDef, Profile, TierFloor } from './types.js';
import type { ComplexityTier } from '../schemas/stack.js';
import type { SlotDef } from '../interview/slots.js';
import type { ProfileId } from './types.js';

/**
 * The ten profiles that get their id, label, layers, required layers per tier
 * and slots in the 12 hours (§6). Their architecture rules, toolchains,
 * prerequisites and addenda are filled in during week 2; until then the
 * blueprint applies no profile rule to them and the prompt adds nothing.
 */

export interface BasicProfileData {
  id: ProfileId;
  label: string;
  signalWords: string[];
  /** `[id, label, section, description, research?]` */
  layers: [string, string, string, string, string?][];
  requiredLayersByTier: Record<ComplexityTier, string[]>;
  slots?: SlotDef[];
  tierFloors?: TierFloor[];
  /** The rule as §6 states it, shown on the brief; checked in code from week 2. */
  rule: string;
  harnesses: HarnessKind[];
  /** Whether this kind of brief usually runs in the browser sandbox (§6's last column). */
  browser?: boolean;
}

export function basicProfile(data: BasicProfileData): Profile {
  const architectureRule: ArchitectureRule = {
    description: data.rule,
    requiredPaths: [],
    firstStepCreates: [],
    forbiddenImports: [],
  };
  const layers: LayerDef[] = data.layers.map(([id, label, section, description, research]) => ({
    id,
    label,
    section,
    description,
    ...(research ? { research } : {}),
  }));
  const browser = data.browser ?? false;
  return {
    id: data.id,
    label: data.label,
    deep: false,
    signalWords: data.signalWords,
    layers,
    requiredLayersByTier: data.requiredLayersByTier,
    slots: data.slots ?? [],
    tierFloors: data.tierFloors ?? [],
    architectureRule,
    harnesses: data.harnesses,
    browserRunnable: () => browser,
    toolchain: [],
    docSources: [{ key: 'base' }],
    prerequisites: [],
    promptAddendum: '',
  };
}
