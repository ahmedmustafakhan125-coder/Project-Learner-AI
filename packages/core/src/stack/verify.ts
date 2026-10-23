import type { ProjectTier } from '@ai-edu/llm';

import type { Profile } from '../profiles/types.js';
import { cardFor, namedTechnologies } from '../research/candidates.js';
import type { TechCard } from '../research/sources.js';
import type { Slots } from '../schemas/interview.js';
import type { ResearchDossier } from '../schemas/research.js';
import { StackBrief } from '../schemas/stack.js';
import type { LayerChoice, Verification } from '../schemas/stack.js';
import type { AlternativeDraft, BriefDraft, LayerDraft } from './draft.js';
import { allowedMajors, majorOf } from './pins.js';
import type { PinTable } from './pins.js';

/**
 * `verifyStackBrief` (docs/project-learner.md §8). Pure, and run on every brief.
 *
 * Repair in code before retrying: what code can fix — an unknown reference,
 * a remembered version, an alternative that repeats the choice, a flow to
 * nowhere — is fixed and logged. Only what it cannot fix — a missing layer,
 * an ignored request, a choice with one pro — is serious, and costs the one
 * retry.
 */

export type BriefRule =
  | 'coverage'
  | 'vocabulary'
  | 'duplicate'
  | 'request'
  | 'padding'
  | 'alternatives'
  | 'architecture'
  | 'grounded'
  | 'version'
  | 'milestones'
  | 'schema';

export interface BriefViolation {
  rule: BriefRule;
  /** Serious costs the retry; repaired was fixed in code and is only logged. */
  severity: 'serious' | 'repaired';
  message: string;
  layer?: string;
}

export interface VerifyBriefInput {
  profile: Profile;
  tier: ProjectTier;
  slots: Slots;
  dossier: ResearchDossier | null;
  pins: PinTable;
  cards: TechCard[];
}

export interface BriefCheck {
  /** The repaired brief, when nothing serious is left. */
  brief: StackBrief | null;
  violations: BriefViolation[];
}

const MAX_MILESTONES: Partial<Record<ProjectTier, number>> = { T4: 3, T5: 6 };
const STRENGTH: Verification[] = ['browser', 'cli', 'static'];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim();
const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function mentions(haystack: string, needle: string): boolean {
  const h = norm(haystack);
  const n = norm(needle);
  return n !== '' && h !== '' && (` ${h} `.includes(` ${n} `) || ` ${n} `.includes(` ${h} `));
}

/** Which check this layer's steps can get, from the profile's harnesses and the brief. */
export function layerVerification(profile: Profile, layerId: string, browser: boolean): Verification {
  const best: Verification = browser
    ? 'browser'
    : profile.harnesses.some((h) => h !== 'headless-app')
      ? 'cli'
      : 'static';
  const cap = profile.layers.find((l) => l.id === layerId)?.check;
  if (!cap) return best;
  return STRENGTH[Math.max(STRENGTH.indexOf(best), STRENGTH.indexOf(cap))]!;
}

export function verifyStackBrief(draft: BriefDraft, input: VerifyBriefInput): BriefCheck {
  const { profile, tier, slots, dossier, pins, cards } = input;
  const violations: BriefViolation[] = [];
  const serious = (rule: BriefRule, message: string, layer?: string) =>
    violations.push({ rule, severity: 'serious', message, ...(layer ? { layer } : {}) });
  const repaired = (rule: BriefRule, message: string, layer?: string) =>
    violations.push({ rule, severity: 'repaired', message, ...(layer ? { layer } : {}) });

  const open = profile.id === 'general';
  const vocabulary = new Map(profile.layers.map((l) => [l.id, l]));
  const byLabel = new Map(profile.layers.map((l) => [slug(l.label), l.id]));
  const refIds = new Set((dossier?.docRefs ?? []).map((r) => r.id));
  const maxAlternatives = tier === 'T1' ? 1 : 2;

  /* ---------------- layers: vocabulary and duplicates ---------------- */

  const layers: LayerDraft[] = [];
  const seen = new Set<string>();
  for (const raw of draft.layers) {
    let id = slug(raw.layer);
    if (!vocabulary.has(id) && byLabel.has(id)) {
      repaired('vocabulary', `"${raw.layer}" read as ${byLabel.get(id)}`, byLabel.get(id));
      id = byLabel.get(id)!;
    }
    if (!open && !vocabulary.has(id)) {
      repaired('vocabulary', `dropped "${raw.layer}": not a ${profile.id} layer`);
      continue;
    }
    if (seen.has(id)) {
      repaired('duplicate', `dropped a second ${id}`, id);
      continue;
    }
    seen.add(id);
    layers.push({ ...raw, layer: id });
  }

  for (const required of profile.requiredLayersByTier[tier]) {
    if (!seen.has(required)) serious('coverage', `missing the required layer ${required}`, required);
  }

  /* ---------------- each choice ---------------- */

  const requested = namedTechnologies(slots, profile);
  /** The same technology by name, or by the tech card both names point at. */
  const sameTech = (a: string, b: string) => {
    if (mentions(a, b)) return true;
    const card = cardFor(a, cards);
    return card !== undefined && card === cardFor(b, cards);
  };
  const isRequested = (name: string) => requested.some((r) => sameTech(name, r));

  const choices: Omit<LayerChoice, 'verification'>[] = layers.map((layer) => {
    const id = layer.layer;
    const card = cardFor(layer.name, cards);
    const cardId = card?.id ?? null;

    if (layer.pros.length < 2) serious('padding', `${id} has ${layer.pros.length} pro(s); at least two`, id);
    if (layer.cons.length < 1) serious('padding', `${id} has no con`, id);

    let alternatives: AlternativeDraft[] = layer.alternatives.filter((alt) => {
      if (norm(alt.name) === norm(layer.name)) {
        repaired('alternatives', `dropped an alternative that repeats ${layer.name}`, id);
        return false;
      }
      if (alt.pros.length < 1 || alt.cons.length < 1) {
        repaired('alternatives', `dropped ${alt.name}: an alternative needs a pro and a con`, id);
        return false;
      }
      return true;
    });
    if (alternatives.length > maxAlternatives) {
      repaired('alternatives', `kept ${maxAlternatives} of ${alternatives.length} alternatives`, id);
      alternatives = alternatives.slice(0, maxAlternatives);
    }
    if (alternatives.length === 0) serious('alternatives', `${id} names no realistic alternative`, id);

    // Grounded: every reference is in the dossier; a layer with none left
    // falls back to its card's reference when the card grounded it.
    let docRefs = [...new Set(layer.docRefs.map((r) => r.replace(/[[\]\s]/g, '')))].filter((r) => refIds.has(r));
    if (docRefs.length < new Set(layer.docRefs).size) repaired('grounded', `dropped references not in the dossier`, id);
    if (docRefs.length === 0 && card) {
      const cardRef = dossier?.docRefs.find((r) => r.url === card.docs);
      if (cardRef) {
        docRefs = [cardRef.id];
        repaired('grounded', `cited the ${card.id} tech card`, id);
      }
    }
    if (docRefs.length === 0) {
      // An empty dossier grounds nothing: there was no documentation to read
      // (T1 with no card, a stack left to the brief on a profile with no
      // research defaults). The brief goes out marked "limited sources"
      // instead of failing every layer, retry included.
      if (refIds.size === 0) repaired('grounded', `${id} cites nothing: the dossier is empty`, id);
      else serious('grounded', `${id} cites no reference from the dossier`, id);
    }

    // Versions come only from the dossier or the pin table (invariant 22).
    let versionMajor = layer.versionMajor?.trim() || null;
    if (versionMajor) {
      const major = majorOf(versionMajor);
      if (!major || !allowedMajors({ name: layer.name, cardId }, pins, dossier).has(major)) {
        repaired('version', `nulled ${layer.name} ${versionMajor}: not in the dossier or the pin table`, id);
        versionMajor = null;
      } else {
        versionMajor = major;
      }
    }

    return {
      layer: id,
      name: layer.name.trim(),
      versionMajor,
      whatItIs: layer.whatItIs,
      roleHere: layer.roleHere,
      whyChosen: layer.whyChosen,
      pros: layer.pros,
      cons: layer.cons,
      learnerCost: layer.learnerCost,
      alternatives,
      requestedByLearner: isRequested(layer.name),
      assumptions: layer.assumptions,
      docRefs,
      cardId,
    };
  });

  /* ---------------- the learner's requests ---------------- */

  for (const tech of requested) {
    if (!choices.some((c) => sameTech(c.name, tech))) {
      serious('request', `the learner asked for ${tech}, and no layer uses it; keep it and explain any poor fit in friction`);
    }
  }

  /* ---------------- architecture ---------------- */

  const layerIds = new Set(choices.map((c) => c.layer));
  const componentIds = new Set<string>();
  const components: BriefDraft['architecture']['components'] = [];
  for (const c of draft.architecture.components) {
    const layer = slug(c.layer);
    const known = layerIds.has(layer) ? layer : byLabel.get(layer);
    if (!known || !layerIds.has(known) || componentIds.has(c.id)) {
      repaired('architecture', `dropped component ${c.id}: ${componentIds.has(c.id) ? 'a duplicate id' : `layer ${c.layer} is not in the brief`}`);
      continue;
    }
    componentIds.add(c.id);
    components.push({ ...c, layer: known });
  }
  const flows = draft.architecture.flows.filter((f) => {
    const ok = componentIds.has(f.from) && componentIds.has(f.to);
    if (!ok) repaired('architecture', `dropped flow ${f.from} -> ${f.to}: it starts or ends off the diagram`);
    return ok;
  });
  if (components.length === 0) serious('architecture', 'the architecture has no component on a listed layer');

  /* ---------------- milestones ---------------- */

  let milestones = draft.milestones;
  const most = MAX_MILESTONES[tier];
  if (most === undefined) {
    if (milestones.length) repaired('milestones', `dropped ${milestones.length} milestone(s): ${tier} is planned as one project`);
    milestones = [];
  } else {
    if (milestones.length === 0) serious('milestones', `${tier} needs a milestone roadmap`);
    if (milestones.length > most) {
      repaired('milestones', `kept ${most} of ${milestones.length} milestones for ${tier}`);
      milestones = milestones.slice(0, most);
    }
    for (const m of milestones) if (!m.outcome.trim()) serious('milestones', `milestone "${m.title}" has no outcome that runs`);
  }

  /* ---------------- toolchain versions ---------------- */

  const toolchain = draft.toolchain.map((t) => {
    if (!t.minVersion) return { ...t, minVersion: null };
    const card = cardFor(t.tool, cards);
    const major = majorOf(t.minVersion);
    if (major && allowedMajors({ name: t.tool, cardId: card?.id ?? null }, pins, dossier).has(major)) return t;
    repaired('version', `nulled ${t.tool} ${t.minVersion}: not in the dossier or the pin table`);
    return { ...t, minVersion: null };
  });

  /* ---------------- assemble ---------------- */

  const provisional = { layers: choices.map((c) => ({ ...c, verification: 'static' as const })) };
  const browser = profile.browserRunnable(provisional as unknown as StackBrief);
  const candidate = {
    profile: profile.id,
    tier,
    summary: draft.summary,
    layers: choices.map((c) => ({ ...c, verification: layerVerification(profile, c.layer, browser) })),
    toolchain,
    architecture: { style: draft.architecture.style, components, flows },
    howItFitsTogether: draft.howItFitsTogether,
    milestones,
    risks: draft.risks,
    friction: draft.friction,
  };

  if (violations.some((v) => v.severity === 'serious')) return { brief: null, violations };

  const parsed = StackBrief.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) serious('schema', `${issue.path.join('.')}: ${issue.message}`);
    return { brief: null, violations };
  }
  return { brief: parsed.data, violations };
}
