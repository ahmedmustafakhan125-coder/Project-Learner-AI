import { getProfile } from '@ai-edu/core';
import type { DocRef, LayerChoice, StackBrief, Verification } from '@ai-edu/core';

/**
 * What the Stack Brief screen shows, worked out without React so it can be
 * tested on its own (docs/project-learner.md §8, "What the learner sees").
 * The tier is never named on it: the learner does not see tiers.
 */

export const VERIFICATION_LABEL: Record<Verification, { label: string; detail: string }> = {
  browser: { label: 'Checked in the browser', detail: 'Its steps run and are tested right here.' },
  cli: { label: 'Checked on your machine', detail: 'Its steps need your own toolchain; the browser checks the code is there.' },
  static: { label: 'Checked by reading the code', detail: 'Nothing runs it automatically; the checkpoint reads your files.' },
};

export interface LayerGroup {
  section: string;
  layers: LayerChoice[];
}

/**
 * Cards grouped by the profile's own sections, in the order the profile lists
 * them (for a kernel: Toolchain, Boot, Kernel, Devices, Tools). Layers the
 * profile does not list, which only `general` allows, go last under "Other".
 */
export function groupLayers(brief: StackBrief): LayerGroup[] {
  const profile = getProfile(brief.profile);
  const sectionOf = new Map(profile.layers.map((l) => [l.id, l.section]));
  const order = [...new Set(profile.layers.map((l) => l.section))];
  const groups = new Map<string, LayerChoice[]>();
  for (const layer of brief.layers) {
    const section = sectionOf.get(layer.layer) ?? 'Other';
    groups.set(section, [...(groups.get(section) ?? []), layer]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)))
    .map(([section, layers]) => ({ section, layers }));
}

/** The label a profile gives a layer id, or the id itself. */
export function layerLabel(brief: StackBrief, layerId: string): string {
  return getProfile(brief.profile).layers.find((l) => l.id === layerId)?.label ?? layerId;
}

/**
 * Only http and https links reach an anchor. A dossier URL passed `z.url()`,
 * which `javascript:` also passes.
 */
export function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** A layer's references, resolved against the brief's sources and in the order cited. */
export function refsFor(layer: LayerChoice, sources: DocRef[]): DocRef[] {
  return layer.docRefs.map((id) => sources.find((s) => s.id === id)).filter((s): s is DocRef => s !== undefined);
}
