import type { CompiledQuery } from '../schemas/interview.js';
import type { KnowledgeBundle, KnowledgeConcept } from './types.js';

/**
 * Choosing which curated concepts to put in front of the model, without
 * retrieval.
 *
 * The interview has already done the hard part. By the time a query is compiled
 * we know the learner's technologies, topic, domain and skill level as explicit
 * slots, so concepts can be matched on tags directly. That means no embeddings,
 * no vector store, and no extra model round trip before the answer starts.
 *
 * Two properties this file must preserve, both load-bearing:
 *
 *   1. **Determinism.** The rendered block sits inside the fan-out's shared
 *      cached prefix. Same query in, byte-identical block out, or the four
 *      agents stop sharing one cache entry and cost quadruples silently.
 *      Nothing here may depend on object key order, `Date`, or randomness.
 *
 *   2. **A hard cap.** Curated or not, the bundle will outgrow the budget it
 *      deserves. Selection is capped and the cap is applied after a total
 *      ordering, so "which N" is never ambiguous.
 */

/** Most concepts to include in one prompt. */
const MAX_CONCEPTS = 6;

/** A tag has to be worth more than an incidental mention in the question text. */
const TAG_MATCH_SCORE = 3;
const BODY_MATCH_SCORE = 1;

/** Slots worth matching against, in a fixed order. */
const MATCHED_SLOTS = ['tech', 'topic', 'domain', 'skill_level'] as const;

/**
 * Words that carry no signal about which concept is relevant.
 *
 * Without this, "what is a closure?" matches anything: `is` alone appears inside
 * "authorisation", "this", "list" and half the English language.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one',
  'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'new', 'now', 'old', 'see',
  'two', 'way', 'who', 'boy', 'did', 'use', 'why', 'what', 'when', 'where', 'this', 'that',
  'with', 'from', 'have', 'does', 'do', 'is', 'a', 'an', 'of', 'to', 'in', 'it', 'on', 'or',
  'my', 'me', 'i', 'be', 'as', 'at', 'by', 'if', 'so', 'up', 'we', 'no', 'am',
]);

/** Break text into comparable words. Both sides of a match go through this. */
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function termsFrom(compiled: CompiledQuery): string[] {
  const raw: string[] = [];

  for (const key of MATCHED_SLOTS) {
    const value = compiled.slots[key]?.value;
    if (value) raw.push(value);
  }
  raw.push(compiled.originalQuery);

  // Sorted and deduplicated so the result cannot depend on the order slots
  // happened to be filled in.
  return [...new Set(raw.flatMap(tokenise))].sort();
}

/** How well one concept answers this query. Higher is better; 0 means skip. */
function scoreConcept(concept: KnowledgeConcept, terms: readonly string[]): number {
  const tags = new Set(concept.tags.map((t) => t.toLowerCase()));
  // Tokenised, not substring-matched: `includes` would score "is" against
  // "authorisation" and make every concept look relevant to every question.
  const words = new Set(tokenise(`${concept.title ?? ''} ${concept.description ?? ''}`));

  let score = 0;
  for (const term of terms) {
    if (tags.has(term)) score += TAG_MATCH_SCORE;
    else if (words.has(term)) score += BODY_MATCH_SCORE;
  }
  return score;
}

/**
 * Pick the concepts worth sending for this query.
 *
 * Ties break on `path`, which is unique, so the ordering is total and the output
 * cannot vary between two runs on the same input.
 */
export function selectConcepts(
  bundle: KnowledgeBundle,
  compiled: CompiledQuery,
  maxConcepts: number = MAX_CONCEPTS,
): KnowledgeConcept[] {
  const terms = termsFrom(compiled);

  return bundle.concepts
    // Deprecated concepts stay in the bundle for their links and history, but
    // must never be presented to a learner as current.
    .filter((concept) => concept.status !== 'deprecated')
    .map((concept) => ({ concept, score: scoreConcept(concept, terms) }))
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score || a.concept.path.localeCompare(b.concept.path))
    .slice(0, maxConcepts)
    .map((scored) => scored.concept);
}

/**
 * Render the selected concepts for the prompt.
 *
 * Returns null when there is nothing to add, so an unmatched query produces
 * byte-for-byte the prompt it produced before this feature existed — no wasted
 * tokens, and no cache key churn for queries the bundle has nothing to say about.
 *
 * The wrapper is `<knowledge>`, deliberately NOT `<attachment>`. Attachments are
 * learner-supplied and untrusted; this bundle is committed to the repository and
 * reviewed. PEDAGOGY_CORE describes the difference so the model does not treat
 * one as the other.
 */
export function renderKnowledge(
  bundle: KnowledgeBundle,
  compiled: CompiledQuery,
  maxConcepts: number = MAX_CONCEPTS,
): string | null {
  const selected = selectConcepts(bundle, compiled, maxConcepts);
  if (selected.length === 0) return null;

  const lines: string[] = ['<knowledge>'];

  if (bundle.index) {
    lines.push('<index>');
    lines.push(bundle.index.trim());
    lines.push('</index>');
  }

  for (const concept of selected) {
    const attrs = [`path="${concept.path}"`, `type="${concept.type}"`];
    if (concept.status === 'draft') attrs.push('status="draft"');
    lines.push(`<concept ${attrs.join(' ')}>`);
    if (concept.title) lines.push(`# ${concept.title}`);
    lines.push(concept.body.trim());
    lines.push('</concept>');
  }

  lines.push('</knowledge>');
  return lines.join('\n');
}
