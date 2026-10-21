import { jaccard, tokenSet } from './canonicalize.js';

/**
 * Assisted recall: has the learner asked this before, in another conversation?
 *
 * Not a redirect. The same words are not always the same need — the learner
 * may know more now, or be asking in a new context — so a match only offers
 * the earlier conversation; the new question is answered either way.
 *
 * Exact first (same fingerprint), then near: word overlap at or above the
 * threshold. No embeddings — the canonical forms are short, and overlap on
 * them catches rephrasings without a model call or a vector store.
 */

/** Share of distinct words two questions must have in common to count as the same one. */
export const RECALL_SIMILARITY = 0.8;

export interface RecallCandidate {
  fingerprint: string;
  canonical: string;
  threadId: string;
  createdAt: string;
}

export interface RecallMatch {
  threadId: string;
  canonical: string;
  askedAt: string;
  /** True for an identical canonical question, false for a close rephrasing. */
  exact: boolean;
  similarity: number;
}

export interface FindRecallOptions {
  /** The conversation the learner is in now; a match there is not a revisit. */
  excludeThreadId?: string | null;
  threshold?: number;
}

function timeOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

export function findRecall(
  canonical: string,
  fingerprint: string,
  candidates: readonly RecallCandidate[],
  { excludeThreadId = null, threshold = RECALL_SIMILARITY }: FindRecallOptions = {},
): RecallMatch | null {
  if (!canonical) return null;
  const pool = candidates.filter((c) => c.threadId !== excludeThreadId);

  const exact = pool.find((c) => c.fingerprint === fingerprint);
  if (exact) {
    return { threadId: exact.threadId, canonical: exact.canonical, askedAt: exact.createdAt, exact: true, similarity: 1 };
  }

  const words = tokenSet(canonical);
  let best: RecallMatch | null = null;
  for (const candidate of pool) {
    const similarity = jaccard(words, tokenSet(candidate.canonical));
    if (similarity < threshold) continue;
    const better =
      !best ||
      similarity > best.similarity ||
      (similarity === best.similarity && timeOf(candidate.createdAt) > timeOf(best.askedAt));
    if (better) {
      best = { threadId: candidate.threadId, canonical: candidate.canonical, askedAt: candidate.createdAt, exact: false, similarity };
    }
  }
  return best;
}
