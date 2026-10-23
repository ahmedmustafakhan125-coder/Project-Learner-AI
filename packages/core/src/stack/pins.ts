import type { ResearchDossier } from '../schemas/research.js';
import type { TechCard } from '../research/sources.js';

/**
 * The pin table (docs/project-learner.md §7 and §8): the major version each
 * tech card pins, refreshed monthly with the cards. A brief's `versionMajor`
 * must match this table or the dossier, and is nulled otherwise
 * (invariant 22) — a version the model remembered is exactly the kind of
 * plausible, stale fact a learner cannot check.
 */

export type PinTable = ReadonlyMap<string, string>;

export function buildPinTable(cards: TechCard[]): PinTable {
  const table = new Map<string, string>();
  for (const card of cards) if (card.pin) table.set(card.id, card.pin);
  return table;
}

/** The first whole number in a version: `v2.5.1` and `2.x` are 2, `C23` is 23. */
export function majorOf(version: string): string | null {
  return /(\d+)/.exec(version)?.[1] ?? null;
}

function sameTech(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim();
  const x = n(a);
  const y = n(b);
  return x !== '' && y !== '' && (x === y || ` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `));
}

/**
 * The majors a layer may claim: its card's pin, and what the dossier saw for
 * a technology of the same name or card.
 */
export function allowedMajors(
  layer: { name: string; cardId: string | null },
  pins: PinTable,
  dossier: ResearchDossier | null,
): Set<string> {
  const majors = new Set<string>();
  const pinned = layer.cardId ? pins.get(layer.cardId) : undefined;
  if (pinned) majors.add(majorOf(pinned) ?? pinned);
  for (const v of dossier?.versions ?? []) {
    if (sameTech(v.tech, layer.name) || (layer.cardId && sameTech(v.tech, layer.cardId))) {
      const major = majorOf(v.versionSeen);
      if (major) majors.add(major);
    }
  }
  return majors;
}
