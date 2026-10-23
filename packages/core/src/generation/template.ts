import type { ProjectTier } from '@ai-edu/llm';

import type { Profile, ProfileId } from '../profiles/types.js';
import { namedTechnologies } from '../research/candidates.js';
import type { CompiledQuery } from '../schemas/interview.js';
import type { StepStub } from '../schemas/project.js';

/**
 * Template reuse: a very similar project already in the database is adapted
 * rather than planned again (docs/project-learner.md §11, "Keeping project
 * creation cheap").
 *
 * Any learner's project can serve, so matching is deliberately strict and
 * deterministic: the same profile, the same tier, exactly the same named
 * technologies, and nearly the same words for what is being built. A match
 * skips research and the brief call, and the plan is adapted by one Sonnet
 * call instead of written by Opus. Nothing about the other learner travels
 * with it: no memory, no code, only the brief, dossier and plan.
 */

/** Below this word overlap two requests are different projects. */
export const SIMILARITY_FLOOR = 0.7;

export interface RequestFingerprint {
  profile: ProfileId;
  tier: ProjectTier;
  /** Named technologies, lowercased and sorted. */
  tech: string[];
  /** The content words of what they asked to build. */
  words: string[];
}

/** Slots that say what is being built; time, level and preferences do not change the project. */
const WHAT_SLOTS = ['domain', 'goal'];

const STOP = new Set(
  (
    'a an the i im i\'m me my we our you your to of in on for with and or but that this it its is are be ' +
    'want wanna would like love need make build create write code program develop learn learning project ' +
    'please help how can could should will using use simple small basic little some new from into by as at so'
  ).split(' '),
);

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

export function fingerprintRequest(compiled: CompiledQuery, profile: Profile, tier: ProjectTier): RequestFingerprint {
  const text = [compiled.originalQuery, ...WHAT_SLOTS.map((k) => compiled.slots[k]?.value ?? '')].join(' ');
  const tech = namedTechnologies(compiled.slots, profile).map((t) => t.toLowerCase().trim());
  return {
    profile: profile.id,
    tier,
    tech: [...new Set(tech)].sort(),
    words: [...new Set(contentWords(text))].sort(),
  };
}

/** Jaccard overlap of the words, or 0 when profile, tier or named technologies differ. */
export function requestSimilarity(a: RequestFingerprint, b: RequestFingerprint): number {
  if (a.profile !== b.profile || a.tier !== b.tier) return 0;
  if (a.tech.length !== b.tech.length || a.tech.some((t, i) => t !== b.tech[i])) return 0;
  const left = new Set(a.words);
  const right = new Set(b.words);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const w of left) if (right.has(w)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export interface TemplateCandidate<T> {
  fingerprint: RequestFingerprint;
  value: T;
}

/** The closest candidate at or above the floor; ties go to the earlier one (callers pass newest first). */
export function pickTemplate<T>(
  fingerprint: RequestFingerprint,
  candidates: TemplateCandidate<T>[],
): { value: T; similarity: number } | null {
  let best: { value: T; similarity: number } | null = null;
  for (const c of candidates) {
    const similarity = requestSimilarity(fingerprint, c.fingerprint);
    if (similarity >= SIMILARITY_FLOOR && (!best || similarity > best.similarity)) best = { value: c.value, similarity };
  }
  return best;
}

/**
 * Whether the template's written step 1 can be served as the new project's
 * step 1 with no call.
 *
 * Step 1 starts from nothing, so it carries no learner's code, which is why
 * only step 1 is ever reused. Its expansion was written knowing the file plan
 * and what step 2 does, so those must be unchanged too.
 */
export function canReuseFirstStep(
  adapted: { finalFileTree: { path: string }[]; steps: StepStub[] },
  template: { finalFileTree: { path: string }[]; steps: StepStub[] },
): boolean {
  const paths = (b: { finalFileTree: { path: string }[] }) => JSON.stringify(b.finalFileTree.map((f) => f.path).sort());
  if (paths(adapted) !== paths(template)) return false;
  const [a1, a2] = adapted.steps;
  const [t1, t2] = template.steps;
  if (!a1 || !t1 || !sameStub(a1, t1)) return false;
  return a2 && t2 ? sameStub(a2, t2) : a2 === t2;
}

/** Whether two stubs describe the same step. */
export function sameStub(a: StepStub, b: StepStub): boolean {
  const list = (x: string[]) => JSON.stringify(x);
  return (
    a.title === b.title &&
    a.objective === b.objective &&
    a.estMinutes === b.estMinutes &&
    list(a.concepts) === list(b.concepts) &&
    list(a.creates) === list(b.creates) &&
    list(a.edits) === list(b.edits)
  );
}
