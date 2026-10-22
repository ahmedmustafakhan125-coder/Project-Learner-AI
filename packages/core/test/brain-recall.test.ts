import { describe, expect, it } from 'vitest';

import { canonicalizeQuery } from '../src/brain/canonicalize.js';
import { RECALL_SIMILARITY, findRecall } from '../src/brain/recall.js';
import type { RecallCandidate } from '../src/brain/recall.js';

/** Fingerprints are hashes in production; any stable string stands in here. */
const fp = (canonical: string) => `fp:${canonical}`;

function candidate(query: string, threadId: string, day: number): RecallCandidate {
  const canonical = canonicalizeQuery(query);
  return { fingerprint: fp(canonical), canonical, threadId, createdAt: new Date(Date.UTC(2026, 9, day)).toISOString() };
}

function recall(query: string, candidates: RecallCandidate[], excludeThreadId: string | null = null) {
  const canonical = canonicalizeQuery(query);
  return findRecall(canonical, fp(canonical), candidates, { excludeThreadId });
}

const history = [
  candidate('What is a closure in JavaScript?', 'thread-a', 3),
  candidate('How do I reverse a linked list?', 'thread-b', 5),
  candidate('explain database indexes', 'thread-c', 7),
];

describe('findRecall', () => {
  it('finds the same question asked politely differently as an exact match', () => {
    expect(recall('Can you explain: what is a closure in JavaScript??', history)).toEqual({
      threadId: 'thread-a',
      canonical: 'what is a closure in javascript',
      askedAt: history[0]?.createdAt,
      exact: true,
      similarity: 1,
    });
  });

  it('finds a close rephrasing as a near match', () => {
    const match = recall('closures in javascript', history);
    expect(match).toMatchObject({ threadId: 'thread-a', exact: false });
    expect(match?.similarity).toBeGreaterThanOrEqual(RECALL_SIMILARITY);
  });

  it('does not match questions that merely share a word', () => {
    expect(recall('reverse a string in python', history)).toBeNull();
    expect(recall('what is a closure in rust and how does the borrow checker treat it', history)).toBeNull();
  });

  it('is not a revisit when the earlier question is in the conversation the learner is in', () => {
    expect(recall('What is a closure in JavaScript?', history, 'thread-a')).toBeNull();
  });

  it('offers the most recent of two equally good matches', () => {
    const twice = [candidate('closures in javascript', 'old', 1), candidate('closures in javascript', 'new', 9)];
    expect(recall('javascript closures', twice)?.threadId).toBe('new');
  });

  it('never matches an empty question', () => {
    expect(findRecall('', '', history)).toBeNull();
  });
});
