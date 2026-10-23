import { describe, expect, it } from 'vitest';

import { PROFILES } from '../src/profiles/index.js';
import type { ProfileId } from '../src/profiles/types.js';
import { REF_TAG } from '../src/research/dossier.js';
import { isAllowedUrl } from '../src/research/sources.js';
import { ResearchDossier } from '../src/schemas/research.js';
import { StackBrief } from '../src/schemas/stack.js';
import type { Slots } from '../src/schemas/interview.js';
import { techStackFromBrief } from '../src/stack/techStack.js';
import { verifyStackBrief } from '../src/stack/verify.js';
import kernel from './fixtures/briefs/kernel.json';
import lox from './fixtures/briefs/lox.json';
import tauri from './fixtures/briefs/tauri.json';

/**
 * The three live Stack Briefs from phase 2 (the kernel, Lox and Tauri), saved
 * by `npm run test:research --workspace @ai-edu/api -- brief.live` with
 * RECORD_FIXTURES=1. They passed `verifyStackBrief` live; this keeps them
 * passing as the checks change, and keeps their sources on the allowlist.
 */

interface Recorded {
  golden: { name: string; profile: ProfileId; tier: 'T1' | 'T2' | 'T3' | 'T4' | 'T5'; slots: Record<string, string> };
  dossier: unknown;
  brief: unknown;
}

const RECORDED = [kernel, lox, tauri] as unknown as Recorded[];

/** Every domain the three briefs may cite: base, their profiles and their research keys. */
const ALLOWED = [
  'developer.mozilla.org', 'docs.python.org', 'doc.rust-lang.org', 'www.rust-lang.org', 'en.cppreference.com', 'nodejs.org/docs',
  'wiki.osdev.org', 'os.phil-opp.com', 'www.qemu.org/docs', 'pdos.csail.mit.edu', 'github.com/limine-bootloader',
  'craftinginterpreters.com', 'v2.tauri.app', 'www.sqlite.org', 'sqlite.org',
];

describe.each(RECORDED.map((r) => [r.golden.name, r] as const))('recorded brief: %s', (_name, recorded) => {
  const { golden } = recorded;
  const profile = PROFILES[golden.profile];
  const dossier = ResearchDossier.parse(recorded.dossier);
  const brief = StackBrief.parse(recorded.brief);
  const slots: Slots = Object.fromEntries(Object.entries(golden.slots).map(([k, v]) => [k, { value: v, source: 'query' as const }]));

  it('still passes verifyStackBrief', () => {
    const draft = { ...brief, layers: brief.layers.map(({ requestedByLearner: _r, verification: _v, cardId: _c, ...rest }) => rest) };
    const check = verifyStackBrief(draft, { profile, tier: golden.tier, slots, dossier, pins: new Map(), cards: [] });
    expect(check.violations.filter((v) => v.severity === 'serious')).toEqual([]);
    expect(check.brief!.layers.map((l) => l.verification)).toEqual(brief.layers.map((l) => l.verification));
  });

  it('covers its required layers and cites only allowlisted pages', () => {
    expect(brief.layers.map((l) => l.layer)).toEqual(expect.arrayContaining(profile.requiredLayersByTier[golden.tier]));
    const byId = new Map(dossier.docRefs.map((r) => [r.id, r]));
    for (const layer of brief.layers) {
      expect(layer.docRefs.length, layer.layer).toBeGreaterThan(0);
      for (const id of layer.docRefs) expect(isAllowedUrl(byId.get(id)!.url, ALLOWED), `${layer.layer} ${id}`).toBe(true);
    }
    for (const m of dossier.notes.matchAll(REF_TAG)) expect(byId.has(m[1]!)).toBe(true);
  });

  it('gives techStack one entry per layer, from the brief alone', () => {
    expect(techStackFromBrief(brief).map((t) => t.role)).toEqual(brief.layers.map((l) => l.roleHere));
  });
});

describe('what the three briefs show the learner', () => {
  it('checks the Lox interpreter in the browser, and the kernel and Tauri app on the command line', () => {
    const verification = (r: Recorded) => new Set(StackBrief.parse(r.brief).layers.map((l) => l.verification));
    expect(verification(lox as unknown as Recorded)).toEqual(new Set(['browser']));
    expect(verification(kernel as unknown as Recorded)).toEqual(new Set(['cli']));
    expect(verification(tauri as unknown as Recorded).has('browser')).toBe(false);
  });

  it('names QEMU in the kernel brief', () => {
    const k = StackBrief.parse((kernel as unknown as Recorded).brief);
    expect(k.layers.find((l) => l.layer === 'emulator')!.name).toMatch(/QEMU/);
  });
});
