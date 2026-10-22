import { tokenSet } from './canonicalize.js';
import type { BrainEdge, BrainNode } from './types.js';

/**
 * The memory block: what the brain recalls about this learner for this one
 * question, small enough to ride along with every answer.
 *
 * Three things, in priority order, inside a hard token budget:
 *
 *   1. A mastery line for the concepts the question touches — "explain fully:
 *      closures (0.45); can assume: promises (0.91)" — so the specialists
 *      know what to teach and what to take as read.
 *   2. Mistakes the learner has made more than once that bear on the
 *      question, so the answer can head them off.
 *   3. Takeaways they already have from earlier sessions, so the answer
 *      builds on them instead of repeating them.
 *
 * Small on purpose. A few hundred tokens of the right history beats pages of
 * the wrong history, and costs a fraction as much.
 *
 * The block is computed ONCE per question and handed to all four agents, so
 * it is byte-identical across them and sits inside their shared cached turn
 * (invariant 1). Nothing in here reads a clock or a random number.
 */

/** Hard ceiling on the rendered block, in estimated tokens. */
export const MEMORY_TOKEN_BUDGET = 600;

export const MEMORY_LIMITS = { insights: 3, mistakes: 2, masteryConcepts: 6 } as const;

/** Below `scaffold` a concept is explained in full; at or above `assume` it can be taken as known. */
export const MASTERY_BANDS = { scaffold: 0.5, assume: 0.8 } as const;

const LABEL_CHARS = 240;

export interface MemoryItem {
  /** The brain node this came from — the UI links its "recalled" chip here. */
  nodeId: string;
  kind: 'concept' | 'insight' | 'mistake';
  label: string;
  /** The thread, project or assessment it was learned in, when known. */
  sourceId: string | null;
}

export interface MemoryBlock {
  text: string;
  items: MemoryItem[];
  /** Estimated size of `text`. Always within the budget it was built for. */
  tokens: number;
}

/** About four characters per token for English prose. An estimate, used as a ceiling. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function timeOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Labels came out of a model reading learner text. They go into the prompt as
 * data, so nothing in one may open or close a tag.
 */
function clean(label: string): string {
  const text = label.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  return text.length <= LABEL_CHARS ? text : `${text.slice(0, LABEL_CHARS - 1).trimEnd()}…`;
}

function shared(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const word of a) if (b.has(word)) n += 1;
  return n;
}

function band(score: number): 'explain fully' | 'familiar' | 'can assume' {
  if (score < MASTERY_BANDS.scaffold) return 'explain fully';
  if (score < MASTERY_BANDS.assume) return 'familiar';
  return 'can assume';
}

interface Scored {
  node: BrainNode;
  relevance: number;
}

export interface BuildMemoryOptions {
  nodes: readonly BrainNode[];
  edges: readonly BrainEdge[];
  /** The learner's question, as typed. */
  query: string;
  maxTokens?: number;
}

export function buildMemoryBlock({
  nodes,
  edges,
  query,
  maxTokens = MEMORY_TOKEN_BUDGET,
}: BuildMemoryOptions): MemoryBlock | null {
  const queryWords = tokenSet(query);
  if (queryWords.size === 0) return null;

  const byId = new Map(nodes.map((node) => [node.id, node]));

  // An insight or mistake is about the concepts it is wired to; their names
  // count toward its relevance as much as its own words do.
  const conceptWords = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== 'RELATED_TO') continue;
    const concept = byId.get(edge.dst);
    if (concept?.kind !== 'concept') continue;
    const list = conceptWords.get(edge.src);
    if (list) list.push(concept.label);
    else conceptWords.set(edge.src, [concept.label]);
  }
  const wordsOf = (node: BrainNode) => tokenSet([node.label, ...(conceptWords.get(node.id) ?? [])].join(' '));

  const relevant = (kind: BrainNode['kind'], keep: (node: BrainNode) => boolean = () => true): Scored[] =>
    nodes
      .filter((node) => node.kind === kind && keep(node))
      .map((node) => ({ node, relevance: shared(queryWords, kind === 'concept' ? tokenSet(node.label) : wordsOf(node)) }))
      .filter((scored) => scored.relevance > 0);

  const byRelevanceThenRecency = (a: Scored, b: Scored) =>
    b.relevance - a.relevance ||
    timeOf(b.node.lastSeenAt) - timeOf(a.node.lastSeenAt) ||
    (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0);

  const concepts = relevant('concept', (node) => node.score !== null)
    .sort(byRelevanceThenRecency)
    .slice(0, MEMORY_LIMITS.masteryConcepts);

  const mistakes = relevant('mistake', (node) => num(node.metadata['occurrences']) > 1)
    .sort(
      (a, b) =>
        b.relevance - a.relevance ||
        num(b.node.metadata['occurrences']) - num(a.node.metadata['occurrences']) ||
        byRelevanceThenRecency(a, b),
    )
    .slice(0, MEMORY_LIMITS.mistakes);

  const insights = relevant('insight').sort(byRelevanceThenRecency).slice(0, MEMORY_LIMITS.insights);

  if (concepts.length === 0 && mistakes.length === 0 && insights.length === 0) return null;

  /* ---- render inside the budget, most useful first ---- */

  const head = [
    '<learner_memory>',
    "What this learner has already done on this platform, recalled for this question.",
  ];
  const tail = ['</learner_memory>'];
  const body: string[] = [];
  const items: MemoryItem[] = [];
  const fits = (extra: string[]) => estimateTokens([...head, ...body, ...extra, ...tail].join('\n')) <= maxTokens;

  // 1. Mastery, grouped by band, weakest first so the most important part
  //    survives if the line has to be cut short.
  const bands = new Map<string, string[]>();
  const masteryItems: MemoryItem[] = [];
  for (const { node } of [...concepts].sort((a, b) => (a.node.score ?? 0) - (b.node.score ?? 0) || byRelevanceThenRecency(a, b))) {
    const score = node.score ?? 0;
    const entry = `${clean(node.label)} (${score.toFixed(2)})`;
    const name = band(score);
    const candidate = new Map(bands);
    candidate.set(name, [...(candidate.get(name) ?? []), entry]);
    const line = renderMastery(candidate);
    if (!fits([line])) break;
    bands.set(name, candidate.get(name) as string[]);
    masteryItems.push({ nodeId: node.id, kind: 'concept', label: node.label, sourceId: null });
  }
  if (bands.size > 0) {
    body.push(renderMastery(bands));
    items.push(...masteryItems);
  }

  // 2. Recurring mistakes.
  const mistakeLines: string[] = [];
  for (const { node } of mistakes) {
    const line = `- ${clean(node.label)} (${num(node.metadata['occurrences'])} times)`;
    const heading = mistakeLines.length === 0 ? ['Mistakes they have made more than once:'] : [];
    if (!fits([...heading, line])) break;
    body.push(...heading, line);
    mistakeLines.push(line);
    items.push({ nodeId: node.id, kind: 'mistake', label: node.label, sourceId: sourceOf(node, 'lastSourceId') });
  }

  // 3. Takeaways they already have.
  let insightHeading = false;
  for (const { node } of insights) {
    const line = `- ${clean(node.label)}`;
    const heading = insightHeading ? [] : ['Takeaways they already have:'];
    if (!fits([...heading, line])) break;
    body.push(...heading, line);
    insightHeading = true;
    items.push({ nodeId: node.id, kind: 'insight', label: node.label, sourceId: sourceOf(node, 'sourceId') });
  }

  if (body.length === 0) return null;
  const text = [...head, ...body, ...tail].join('\n');
  return { text, items, tokens: estimateTokens(text) };
}

const BAND_ORDER = ['explain fully', 'familiar', 'can assume'] as const;

function renderMastery(bands: ReadonlyMap<string, string[]>): string {
  const parts = BAND_ORDER.filter((name) => bands.has(name)).map((name) => `${name}: ${(bands.get(name) ?? []).join(', ')}`);
  return `Mastery — ${parts.join('; ')}`;
}

function sourceOf(node: BrainNode, field: string): string | null {
  const value = node.metadata[field];
  return typeof value === 'string' ? value : null;
}
