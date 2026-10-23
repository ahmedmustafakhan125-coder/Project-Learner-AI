import { assessmentOffers } from '../assessment/triggers.js';
import { MASTERY_BANDS } from '../brain/memory.js';
import type { BrainEdge, BrainNode } from '../brain/types.js';
import { conceptActivity, halfLifeDecay } from './interests.js';
import type { NavProject, NavThread, Recommendation, RecommendationKind } from './types.js';

/**
 * What to do next, from what the learner has already done.
 *
 * Rules over the stored brain, projects and conversations — no model is
 * involved, so a suggestion costs nothing and the same history always gives
 * the same list. Each rule produces scored candidates; the list keeps the best,
 * one per target and at most `perKind` of any one kind, so a learner with ten
 * weak concepts still sees a project to continue.
 *
 * The reasons are fixed templates. Labels and titles are the only stored text
 * that reaches them.
 */

export const RECOMMEND_RULES = {
  limit: 5,
  perKind: 2,
  /** The newest active project, fading with this half-life since it was touched. */
  continueProject: { weight: 1.0, halfLifeDays: 7 },
  /** Concepts `assessmentOffers` would offer a test on. */
  assess: { weight: 0.9, limit: 2 },
  /** Below the scaffold band, reached in a few conversations, seen recently. */
  strengthen: { weight: 0.8, below: MASTERY_BANDS.scaffold, minSessions: 2, withinDays: 21, halfLifeDays: 14 },
  /** A conversation that reached a concept worth strengthening, idle a few days. */
  revisitThread: { weight: 0.6, idleDays: 3, halfLifeDays: 14 },
  /** Asked about often, past the scaffold band, never exercised in a project. */
  nextProject: { weight: 0.5, atLeast: MASTERY_BANDS.scaffold, minSessions: 3 },
} as const;

export interface RecommendInput {
  /** Concept nodes. Other kinds are ignored. */
  nodes: readonly BrainNode[];
  /** ACTIVATED edges at least; others are ignored. */
  edges: readonly BrainEdge[];
  /** Null when projects failed to load: the project rules are skipped, not guessed. */
  projects: readonly NavProject[] | null;
  /** Recent threads. Null when they failed to load. */
  threads: readonly NavThread[] | null;
  now: string;
}

const DAY_MS = 86_400_000;
const THREAD_SESSION = 'session:thread:';

const percent = (score: number | null) => `${Math.round((score ?? 0) * 100)}%`;

function ago(iso: string, now: string): string {
  const days = Math.floor((Date.parse(now) - Date.parse(iso)) / DAY_MS);
  if (!Number.isFinite(days) || days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

function conversations(count: number): string {
  return count === 1 ? '1 conversation' : `${count} conversations`;
}

function candidate(
  kind: RecommendationKind,
  target: Recommendation['target'],
  title: string,
  reason: string,
  score: number,
): Recommendation {
  return { id: `${kind}:${target.id}`, kind, title, reason, target, score };
}

export function recommendNext(input: RecommendInput): Recommendation[] {
  const { now } = input;
  const at = Date.parse(now);
  const concepts = input.nodes.filter((node) => node.kind === 'concept');
  const activity = conceptActivity(input.edges);
  const candidates: Recommendation[] = [];

  /* ---- continue the newest active project ---- */
  const active = (input.projects ?? [])
    .filter((project) => project.status === 'active')
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.id < b.id ? -1 : 1))[0];
  if (active) {
    const rule = RECOMMEND_RULES.continueProject;
    const step =
      active.currentStep !== null && active.stepCount
        ? `Step ${Math.min(active.currentStep + 1, active.stepCount)} of ${active.stepCount} · `
        : '';
    candidates.push(
      candidate(
        'continue_project',
        { type: 'project', id: active.id, label: active.title },
        `Continue ${active.title}`,
        `${step}last worked on ${ago(active.updatedAt, now)}`,
        rule.weight * halfLifeDecay(active.updatedAt, now, rule.halfLifeDays),
      ),
    );
  }

  /* ---- test yourself ---- */
  for (const node of assessmentOffers(concepts, now, RECOMMEND_RULES.assess.limit)) {
    candidates.push(
      candidate(
        'assess',
        { type: 'concept', id: node.id, label: node.label },
        `Test yourself on ${node.label}`,
        `Mastery ${percent(node.score)} — ready to check it stuck`,
        RECOMMEND_RULES.assess.weight * (node.score ?? 0),
      ),
    );
  }

  /* ---- strengthen weak, recent concepts ---- */
  const weak = new Set<string>();
  {
    const rule = RECOMMEND_RULES.strengthen;
    for (const node of concepts) {
      const sessions = activity.get(node.id)?.sessions.size ?? 0;
      const mastery = node.score ?? 0;
      if (mastery >= rule.below || sessions < rule.minSessions) continue;
      if (at - Date.parse(node.lastSeenAt) > rule.withinDays * DAY_MS) continue;
      weak.add(node.id);
      candidates.push(
        candidate(
          'strengthen',
          { type: 'concept', id: node.id, label: node.label },
          `Strengthen ${node.label}`,
          `Asked about in ${conversations(sessions)} · mastery ${percent(node.score)}`,
          rule.weight * (1 - mastery) * halfLifeDecay(node.lastSeenAt, now, rule.halfLifeDays),
        ),
      );
    }
  }

  /* ---- pick a conversation back up ---- */
  if (input.threads && weak.size > 0) {
    const rule = RECOMMEND_RULES.revisitThread;
    const labels = new Map(concepts.map((node) => [node.id, node.label]));
    // The first concept worth strengthening that each thread reached, in the
    // order the brain recorded; the id settles ties so input order never does.
    const reached = new Map<string, string>();
    const walk = [...input.edges].sort(
      (a, b) => order(a) - order(b) || (a.dst < b.dst ? -1 : a.dst > b.dst ? 1 : 0),
    );
    for (const edge of walk) {
      if (edge.kind !== 'ACTIVATED' || !edge.src.startsWith(THREAD_SESSION) || !weak.has(edge.dst)) continue;
      const threadId = edge.src.slice(THREAD_SESSION.length);
      if (!reached.has(threadId)) reached.set(threadId, edge.dst);
    }
    for (const thread of input.threads) {
      const conceptId = reached.get(thread.id);
      if (!conceptId) continue;
      if (at - Date.parse(thread.updatedAt) < rule.idleDays * DAY_MS) continue;
      candidates.push(
        candidate(
          'revisit_thread',
          { type: 'thread', id: thread.id, label: thread.title },
          `Pick up “${thread.title}”`,
          `Covers ${labels.get(conceptId) ?? 'a concept'} · last opened ${ago(thread.updatedAt, now)}`,
          rule.weight * halfLifeDecay(thread.updatedAt, now, rule.halfLifeDays),
        ),
      );
    }
  }

  /* ---- build with what you know ---- */
  {
    const rule = RECOMMEND_RULES.nextProject;
    for (const node of concepts) {
      const entry = activity.get(node.id);
      const sessions = entry?.sessions.size ?? 0;
      if ((node.score ?? 0) < rule.atLeast || sessions < rule.minSessions) continue;
      if ((entry?.projects.size ?? 0) > 0) continue;
      candidates.push(
        candidate(
          'next_project',
          { type: 'concept', id: node.id, label: node.label },
          `Build something with ${node.label}`,
          `Asked about in ${conversations(sessions)}, not built with yet`,
          rule.weight * (node.score ?? 0),
        ),
      );
    }
  }

  return pick(candidates);
}

function order(edge: BrainEdge): number {
  const value = edge.metadata['order'];
  return typeof value === 'number' ? value : Number.MAX_SAFE_INTEGER;
}

/** Best first; one per target, `perKind` per kind, `limit` in all. Ties go to the id. */
function pick(candidates: Recommendation[]): Recommendation[] {
  const sorted = candidates
    .filter((entry) => Number.isFinite(entry.score) && entry.score > 0)
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const targets = new Set<string>();
  const perKind = new Map<RecommendationKind, number>();
  const chosen: Recommendation[] = [];
  for (const entry of sorted) {
    if (chosen.length >= RECOMMEND_RULES.limit) break;
    const target = `${entry.target.type}:${entry.target.id}`;
    const kindCount = perKind.get(entry.kind) ?? 0;
    if (targets.has(target) || kindCount >= RECOMMEND_RULES.perKind) continue;
    targets.add(target);
    perKind.set(entry.kind, kindCount + 1);
    chosen.push({ ...entry, score: Math.round(entry.score * 1000) / 1000 });
  }
  return chosen;
}
