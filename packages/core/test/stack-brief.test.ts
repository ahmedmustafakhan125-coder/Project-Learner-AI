import type { LLMProvider, LLMRequest, ProjectTier } from '@ai-edu/llm';
import { PROJECT_TIERS } from '@ai-edu/llm';
import { describe, expect, it } from 'vitest';

import { PROFILES } from '../src/profiles/index.js';
import { PROFILE_IDS } from '../src/profiles/types.js';
import type { Profile } from '../src/profiles/types.js';
import { dossierFromCards, mergeDossiers } from '../src/research/dossier.js';
import { TechCard } from '../src/research/sources.js';
import { ResearchDossier } from '../src/schemas/research.js';
import type { CompiledQuery, Slots } from '../src/schemas/interview.js';
import { BRIEF_MAX_ATTEMPTS, BRIEF_SYSTEM, BriefRejectedError, buildBriefTurn, generateBrief } from '../src/stack/brief.js';
import type { BriefDraft, LayerDraft } from '../src/stack/draft.js';
import { buildPinTable } from '../src/stack/pins.js';
import { techStackFromBrief } from '../src/stack/techStack.js';
import { verifyStackBrief } from '../src/stack/verify.js';

const card = (over: Partial<TechCard> & { id: string }): TechCard =>
  TechCard.parse({ title: over.id, description: `${over.id} card.`, pinnedOn: '2026-10-20', docs: `https://docs.example.org/${over.id}/`, ...over });

const CARDS = [
  card({ id: 'tauri', title: 'Tauri 2', aliases: ['tauri'], pin: '2', layers: ['ui-toolkit', 'ipc', 'packaging'], docs: 'https://v2.tauri.app/start/' }),
  card({ id: 'sqlite', title: 'SQLite', pin: '3', layers: ['local-storage'], docs: 'https://www.sqlite.org/docs.html' }),
  card({ id: 'rust', title: 'Rust', pin: '1', layers: ['app-architecture'], docs: 'https://doc.rust-lang.org/book/' }),
];
const PINS = buildPinTable(CARDS);

const RESEARCHED = ResearchDossier.parse({
  scope: 'project',
  notes: '# osdev-core\n## Versions\n- QEMU | 10.1.0 [d1]',
  docRefs: [{ id: 'd1', url: 'https://www.qemu.org/docs/master/', title: 'QEMU', citedText: 'x', retrievedAt: 't', vetted: true }],
  versions: [{ tech: 'QEMU', versionSeen: '10.1.0', ref: 'd1' }],
  apis: [],
  toolchain: [],
});
const DOSSIER = mergeDossiers([dossierFromCards(CARDS), RESEARCHED]);

const slots = (values: Record<string, string>): Slots =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v, source: 'query' as const }]));

const layerDraft = (layer: string, name: string, over: Partial<LayerDraft> = {}): LayerDraft => ({
  layer,
  name,
  versionMajor: null,
  whatItIs: `${name} is a tool.`,
  roleHere: `It does ${layer} here.`,
  whyChosen: `Better than Other for this.`,
  pros: ['Small', 'Fast'],
  cons: ['New'],
  learnerCost: 'A weekend of reading.',
  alternatives: [{ name: `Other ${layer}`, pros: ['Known'], cons: ['Heavy'], pickWhen: 'When size does not matter.', switchCost: 'medium' }],
  assumptions: [],
  docRefs: ['d1'],
  ...over,
});

/** A draft that covers every required layer and passes every check. */
function goodDraft(profile: Profile, tier: ProjectTier, names: Record<string, string> = {}): BriefDraft {
  const layers = profile.requiredLayersByTier[tier].map((id) => layerDraft(id, names[id] ?? `Tool for ${id}`));
  const most = tier === 'T4' ? 3 : tier === 'T5' ? 6 : 0;
  return {
    summary: 'A stack.',
    layers,
    toolchain: [],
    architecture: {
      style: 'One core',
      components: layers.map((l, i) => ({ id: `c${i}`, name: l.name, layer: l.layer, purpose: 'Does a thing' })),
      flows: layers.length > 1 ? [{ from: 'c0', to: 'c1', label: 'calls' }] : [],
    },
    howItFitsTogether: 'A request goes through.',
    milestones: Array.from({ length: Math.min(most, 2) }, (_, i) => ({ title: `M${i + 1}`, outcome: 'It boots.' })),
    risks: [],
    friction: [],
  };
}

const TAURI_NAMES = { 'ui-toolkit': 'Tauri', 'app-architecture': 'Rust core', ipc: 'Tauri commands', 'local-storage': 'SQLite', packaging: 'Tauri bundler' };
const tauriInput = (over: Record<string, unknown> = {}) => ({
  profile: PROFILES['desktop-app'],
  tier: 'T3' as const,
  slots: slots({ tech: 'Tauri' }),
  dossier: DOSSIER,
  pins: PINS,
  cards: CARDS,
  ...over,
});

/* ------------------------------------------------------------------ *
 * stackBrief.verify
 * ------------------------------------------------------------------ */

describe('verifyStackBrief: coverage per profile and tier', () => {
  const cases = PROFILE_IDS.flatMap((id) => PROJECT_TIERS.map((tier) => [id, tier] as const));

  it.each(cases)('%s at %s passes a draft that covers its required layers, and fails one missing a layer', (id, tier) => {
    const profile = PROFILES[id];
    const input = { profile, tier, slots: {}, dossier: DOSSIER, pins: PINS, cards: CARDS };
    const ok = verifyStackBrief(goodDraft(profile, tier), input);
    expect(ok.violations.filter((v) => v.severity === 'serious')).toEqual([]);
    expect(ok.brief).not.toBeNull();
    expect(ok.brief!.layers.map((l) => l.layer)).toEqual(profile.requiredLayersByTier[tier]);

    const missing = goodDraft(profile, tier);
    const dropped = missing.layers.shift()!;
    const bad = verifyStackBrief(missing, input);
    expect(bad.brief).toBeNull();
    expect(bad.violations).toContainEqual(expect.objectContaining({ rule: 'coverage', severity: 'serious', layer: dropped.layer }));
  });

  it('drops a layer outside the vocabulary, except under general', () => {
    const draft = goodDraft(PROFILES['desktop-app'], 'T3', TAURI_NAMES);
    draft.layers.push(layerDraft('blockchain', 'Ethereum'));
    const result = verifyStackBrief(draft, tauriInput());
    expect(result.brief!.layers.map((l) => l.layer)).not.toContain('blockchain');
    expect(result.violations).toContainEqual(expect.objectContaining({ rule: 'vocabulary', severity: 'repaired' }));

    const general = goodDraft(PROFILES.general, 'T3');
    general.layers.push(layerDraft('signal-processing', 'NumPy'));
    const open = verifyStackBrief(general, { ...tauriInput(), profile: PROFILES.general, slots: {} });
    expect(open.brief!.layers.map((l) => l.layer)).toContain('signal-processing');
  });

  it('reads a layer label as its id, and drops a duplicate', () => {
    const draft = goodDraft(PROFILES['desktop-app'], 'T3', TAURI_NAMES);
    draft.layers[0] = { ...draft.layers[0]!, layer: 'UI toolkit' };
    draft.layers.push(layerDraft('ipc', 'Another IPC'));
    const result = verifyStackBrief(draft, tauriInput());
    expect(result.brief!.layers.filter((l) => l.layer === 'ipc')).toHaveLength(1);
    expect(result.brief!.layers[0]!.layer).toBe('ui-toolkit');
  });
});

describe('verifyStackBrief: the learner, padding and alternatives', () => {
  it('marks the requested technology and fails a brief that ignores it', () => {
    const ok = verifyStackBrief(goodDraft(PROFILES['desktop-app'], 'T3', TAURI_NAMES), tauriInput());
    expect(ok.brief!.layers.find((l) => l.layer === 'ui-toolkit')!.requestedByLearner).toBe(true);
    expect(ok.brief!.layers.find((l) => l.layer === 'local-storage')!.requestedByLearner).toBe(false);

    const ignored = verifyStackBrief(goodDraft(PROFILES['desktop-app'], 'T3', { ...TAURI_NAMES, 'ui-toolkit': 'Electron', ipc: 'preload bridge', packaging: 'electron-builder' }), tauriInput());
    expect(ignored.brief).toBeNull();
    expect(ignored.violations).toContainEqual(expect.objectContaining({ rule: 'request', severity: 'serious' }));
  });

  it('fails a choice with one pro or no con', () => {
    const draft = goodDraft(PROFILES['desktop-app'], 'T3', TAURI_NAMES);
    draft.layers[1] = { ...draft.layers[1]!, pros: ['Only one'] };
    draft.layers[2] = { ...draft.layers[2]!, cons: [] };
    const rules = verifyStackBrief(draft, tauriInput()).violations.filter((v) => v.severity === 'serious').map((v) => v.rule);
    expect(rules).toEqual(['padding', 'padding']);
  });

  it('drops an alternative that repeats the choice, and keeps one for T1', () => {
    const draft = goodDraft(PROFILES['desktop-app'], 'T1', { 'ui-toolkit': 'Tauri' });
    draft.layers[0]!.alternatives = [
      { name: 'tauri', pros: ['a'], cons: ['b'], pickWhen: 'x', switchCost: 'low' },
      { name: 'Electron', pros: ['a'], cons: ['b'], pickWhen: 'x', switchCost: 'low' },
      { name: 'Qt', pros: ['a'], cons: ['b'], pickWhen: 'x', switchCost: 'high' },
    ];
    const result = verifyStackBrief(draft, { ...tauriInput(), tier: 'T1' });
    expect(result.brief!.layers[0]!.alternatives.map((a) => a.name)).toEqual(['Electron']);
  });

  it('fails a choice whose only alternative is itself', () => {
    const draft = goodDraft(PROFILES['desktop-app'], 'T3', TAURI_NAMES);
    draft.layers[0]!.alternatives = [{ name: 'Tauri', pros: ['a'], cons: ['b'], pickWhen: 'x', switchCost: 'low' }];
    expect(verifyStackBrief(draft, tauriInput()).violations).toContainEqual(expect.objectContaining({ rule: 'alternatives', severity: 'serious' }));
  });
});

describe('verifyStackBrief: grounded, and invariant 22', () => {
  it('drops references the dossier does not hold, and falls back to the layer card', () => {
    const draft = goodDraft(PROFILES['desktop-app'], 'T3', TAURI_NAMES);
    draft.layers[3] = { ...draft.layers[3]!, docRefs: ['d42'] };
    const result = verifyStackBrief(draft, tauriInput());
    const sqliteRef = DOSSIER.docRefs.find((r) => r.url === 'https://www.sqlite.org/docs.html')!.id;
    expect(result.brief!.layers[3]!.docRefs).toEqual([sqliteRef]);
    expect(result.brief!.layers[3]!.cardId).toBe('sqlite');
  });

  it('fails a layer with no reference and no card to fall back on', () => {
    const draft = goodDraft(PROFILES['desktop-app'], 'T3', TAURI_NAMES);
    draft.layers[1] = { ...draft.layers[1]!, name: 'Kotlin core', docRefs: [] };
    expect(verifyStackBrief(draft, tauriInput()).violations).toContainEqual(expect.objectContaining({ rule: 'grounded', severity: 'serious' }));
  });

  /*
   * "Make a website for my cooking business", stack left to the brief: the
   * web profiles name nothing to research, so the dossier came back empty and
   * every layer failed this rule twice, retry included, with nothing the model
   * could have cited. An empty dossier now passes, logged; the brief is marked
   * limited sources.
   */
  it('lets layers cite nothing when the dossier is empty, and logs it', () => {
    const profile = PROFILES['web-frontend'];
    const empty = ResearchDossier.parse({ scope: 'project', notes: '', docRefs: [], versions: [], apis: [], toolchain: [] });
    for (const dossier of [empty, null]) {
      const result = verifyStackBrief(goodDraft(profile, 'T2'), { profile, tier: 'T2', slots: {}, dossier, pins: PINS, cards: [] });
      expect(result.brief).not.toBeNull();
      expect(result.brief!.layers.every((l) => l.docRefs.length === 0)).toBe(true);
      expect(result.violations).toContainEqual(expect.objectContaining({ rule: 'grounded', severity: 'repaired', layer: 'ui-framework' }));
    }
  });

  it('keeps a version from the pin table or the dossier, and nulls any other', () => {
    const draft = goodDraft(PROFILES['desktop-app'], 'T3', TAURI_NAMES);
    draft.layers[0] = { ...draft.layers[0]!, versionMajor: 'v2' }; // Tauri pinned 2
    draft.layers[3] = { ...draft.layers[3]!, versionMajor: '4' }; // SQLite pinned 3
    draft.layers[1] = { ...draft.layers[1]!, versionMajor: '1.80' }; // Rust core: card rust, pin 1
    const result = verifyStackBrief(draft, tauriInput());
    expect(result.brief!.layers[0]!.versionMajor).toBe('2');
    expect(result.brief!.layers[3]!.versionMajor).toBeNull();
    expect(result.brief!.layers[1]!.versionMajor).toBe('1');
    expect(result.violations).toContainEqual(expect.objectContaining({ rule: 'version', severity: 'repaired', layer: 'local-storage' }));
  });

  it('takes a version the dossier saw for a technology with no card', () => {
    const profile = PROFILES['systems-os'];
    const draft = goodDraft(profile, 'T4', { emulator: 'QEMU' });
    const emulator = draft.layers.findIndex((l) => l.layer === 'emulator');
    draft.layers[emulator] = { ...draft.layers[emulator]!, versionMajor: '10' };
    const result = verifyStackBrief(draft, { ...tauriInput(), profile, tier: 'T4', slots: {} });
    expect(result.brief!.layers[emulator]!.versionMajor).toBe('10');
  });

  it('nulls a remembered toolchain version too', () => {
    const draft = goodDraft(PROFILES['desktop-app'], 'T3', TAURI_NAMES);
    draft.toolchain = [
      { tool: 'Rust', minVersion: '1.77', installHint: { linux: 'rustup' } },
      { tool: 'Node.js', minVersion: '22', installHint: {} },
    ];
    const result = verifyStackBrief(draft, tauriInput());
    expect(result.brief!.toolchain.map((t) => t.minVersion)).toEqual(['1.77', null]);
  });
});

describe('verifyStackBrief: architecture, milestones and verification', () => {
  it('drops components off the listed layers and flows to nowhere', () => {
    const draft = goodDraft(PROFILES['desktop-app'], 'T3', TAURI_NAMES);
    draft.architecture.components.push({ id: 'cloud', name: 'Cloud sync', layer: 'sync-server', purpose: 'x' });
    draft.architecture.flows.push({ from: 'c0', to: 'cloud', label: 'syncs' }, { from: 'ghost', to: 'c1', label: '?' });
    const result = verifyStackBrief(draft, tauriInput());
    expect(result.brief!.architecture.components.map((c) => c.id)).not.toContain('cloud');
    expect(result.brief!.architecture.flows).toEqual([{ from: 'c0', to: 'c1', label: 'calls' }]);
  });

  it('fails an architecture with no component on a listed layer', () => {
    const draft = goodDraft(PROFILES['desktop-app'], 'T3', TAURI_NAMES);
    draft.architecture.components = [];
    expect(verifyStackBrief(draft, tauriInput()).violations).toContainEqual(expect.objectContaining({ rule: 'architecture', severity: 'serious' }));
  });

  it('fits milestones to the tier: none below T4, at most 3 for T4 and 6 for T5', () => {
    const t3 = goodDraft(PROFILES['desktop-app'], 'T3', TAURI_NAMES);
    t3.milestones = [{ title: 'M1', outcome: 'Runs' }];
    expect(verifyStackBrief(t3, tauriInput()).brief!.milestones).toEqual([]);

    const t4 = goodDraft(PROFILES['systems-os'], 'T4');
    t4.milestones = Array.from({ length: 5 }, (_, i) => ({ title: `M${i}`, outcome: 'Boots' }));
    const input = { ...tauriInput(), profile: PROFILES['systems-os'], tier: 'T4' as const, slots: {} };
    expect(verifyStackBrief(t4, input).brief!.milestones).toHaveLength(3);

    t4.milestones = [];
    expect(verifyStackBrief(t4, input).violations).toContainEqual(expect.objectContaining({ rule: 'milestones', severity: 'serious' }));
  });

  it('sets verification in code: browser for a stdlib Python interpreter, cli for a kernel', () => {
    const lox = verifyStackBrief(goodDraft(PROFILES['language-tooling'], 'T2', { 'host-language': 'Python 3' }), {
      ...tauriInput(),
      profile: PROFILES['language-tooling'],
      tier: 'T2',
      slots: {},
    });
    expect(new Set(lox.brief!.layers.map((l) => l.verification))).toEqual(new Set(['browser']));

    const kernel = verifyStackBrief(goodDraft(PROFILES['systems-os'], 'T4'), { ...tauriInput(), profile: PROFILES['systems-os'], tier: 'T4', slots: {} });
    expect(new Set(kernel.brief!.layers.map((l) => l.verification))).toEqual(new Set(['cli']));
  });

  it('caps a layer at its own check: a desktop updater is static', () => {
    const result = verifyStackBrief(goodDraft(PROFILES['desktop-app'], 'T4', TAURI_NAMES), { ...tauriInput(), tier: 'T4' });
    const byLayer = Object.fromEntries(result.brief!.layers.map((l) => [l.layer, l.verification]));
    expect(byLayer['updates']).toBe('static');
    expect(byLayer['ui-toolkit']).toBe('cli');
  });
});

/* ------------------------------------------------------------------ *
 * techStackFromBrief
 * ------------------------------------------------------------------ */

describe('techStackFromBrief', () => {
  const brief = verifyStackBrief(
    (() => {
      const d = goodDraft(PROFILES['desktop-app'], 'T3', { ...TAURI_NAMES, 'ui-toolkit': 'Tauri 2' });
      d.layers[0] = { ...d.layers[0]!, versionMajor: '2' };
      d.layers[3] = { ...d.layers[3]!, versionMajor: '3' };
      return d;
    })(),
    tauriInput(),
  ).brief!;

  it('lists every layer in order, from the brief alone', () => {
    const stack = techStackFromBrief(brief);
    expect(stack.map((t) => t.name)).toEqual(['Tauri 2', 'Rust core', 'Tauri commands', 'SQLite 3', 'Tauri bundler']);
    expect(stack[0]).toEqual({ name: 'Tauri 2', role: brief.layers[0]!.roleHere, why: brief.layers[0]!.whyChosen });
  });

  it('is deterministic', () => {
    expect(JSON.stringify(techStackFromBrief(brief))).toBe(JSON.stringify(techStackFromBrief(structuredClone(brief))));
  });
});

/* ------------------------------------------------------------------ *
 * generateBrief
 * ------------------------------------------------------------------ */

const compiled: CompiledQuery = {
  intent: 'project_generation',
  originalQuery: 'A Tauri notes app',
  text: '<learner_question>\nA Tauri notes app\n</learner_question>',
  slots: slots({ domain: 'notes app', tech: 'Tauri' }),
  attachments: [],
  partial: false,
};

function scriptedProvider(drafts: BriefDraft[]) {
  const requests: LLMRequest[] = [];
  const provider = {
    id: 'anthropic',
    modelId: 'claude-sonnet-5-5',
    capabilities: {},
    async structured(req: LLMRequest) {
      requests.push(req);
      return {
        data: drafts[Math.min(requests.length - 1, drafts.length - 1)],
        usage: { inputTokens: 10_000, outputTokens: 3_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: 'claude-sonnet-5-5',
        strategy: 'native-schema',
        repaired: false,
      };
    },
  } as unknown as LLMProvider;
  return { provider, requests };
}

const briefOptions = (provider: LLMProvider) => ({
  provider,
  compiled,
  profile: PROFILES['desktop-app'],
  tier: 'T3' as const,
  slots: compiled.slots,
  dossier: DOSSIER,
  cards: CARDS,
  pins: PINS,
  memory: '<learner_memory>\nCan assume: TypeScript.\n</learner_memory>',
  reasoning: 'medium' as const,
  maxTokens: 8_000,
});

describe('generateBrief', () => {
  it('returns the checked brief from one call when nothing is serious', async () => {
    const { provider, requests } = scriptedProvider([goodDraft(PROFILES['desktop-app'], 'T3', TAURI_NAMES)]);
    const result = await generateBrief(briefOptions(provider));
    expect(requests).toHaveLength(1);
    expect(result.data.attempts).toBe(1);
    expect(result.data.brief.profile).toBe('desktop-app');
    expect(requests[0]!.reasoning).toBe('medium');
    expect(requests[0]!.maxTokens).toBe(8_000);
  });

  it('retries once with the violations appended, and sums the usage', async () => {
    const bad = goodDraft(PROFILES['desktop-app'], 'T3', TAURI_NAMES);
    bad.layers.pop();
    const { provider, requests } = scriptedProvider([bad, goodDraft(PROFILES['desktop-app'], 'T3', TAURI_NAMES)]);
    const result = await generateBrief(briefOptions(provider));
    expect(requests).toHaveLength(2);
    expect(result.data.attempts).toBe(2);
    expect(result.usage.inputTokens).toBe(20_000);
    const retry = requests[1]!.messages[0]!.content as string;
    expect(retry).toContain('<previous_attempt_problems>');
    expect(retry).toContain('missing the required layer packaging');
  });

  it('gives up after BRIEF_MAX_ATTEMPTS, carrying the usage it spent', async () => {
    const bad = goodDraft(PROFILES['desktop-app'], 'T3', TAURI_NAMES);
    bad.layers.pop();
    const { provider, requests } = scriptedProvider([bad]);
    const error = await generateBrief(briefOptions(provider)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BriefRejectedError);
    expect(requests).toHaveLength(BRIEF_MAX_ATTEMPTS);
    expect((error as BriefRejectedError).usage.inputTokens).toBe(10_000 * BRIEF_MAX_ATTEMPTS);
  });

  it('puts memory, the addendum, the cards and the dossier in the user turn, wrapped', async () => {
    const { provider, requests } = scriptedProvider([goodDraft(PROFILES['desktop-app'], 'T3', TAURI_NAMES)]);
    await generateBrief(briefOptions(provider));
    const req = requests[0]!;
    expect(req.system).toEqual([{ text: BRIEF_SYSTEM, cacheBoundary: true }]);
    const turn = req.messages[0]!.content as string;
    expect(turn.indexOf('<learner_memory>')).toBe(0);
    expect(turn).toContain(PROFILES['desktop-app'].promptAddendum);
    expect(turn).toContain('<tech_cards>');
    expect(turn).toMatch(/<docs_dossier>[\s\S]*\[d1\] Tauri 2 — https:\/\/v2\.tauri\.app\/start\/[\s\S]*<\/docs_dossier>/);
    expect(turn).toContain('Technologies the learner named: Tauri.');
    expect(turn.endsWith(compiled.text)).toBe(true);
  });

  it('asks for one alternative at T1 and milestones only at T4 and T5', () => {
    const base = briefOptions(scriptedProvider([]).provider);
    expect(buildBriefTurn({ ...base, tier: 'T1' })).toContain('Alternatives per layer: exactly 1.');
    expect(buildBriefTurn({ ...base, tier: 'T3' })).toContain('No milestones');
    expect(buildBriefTurn({ ...base, profile: PROFILES['systems-os'], tier: 'T5' })).toContain('up to 6 milestones');
  });
});
