import { describe, expect, it } from 'vitest';

import { canonicalizeConcept, canonicalizeQuery, jaccard, tokenSet } from '../src/brain/canonicalize.js';

/**
 * Goldens for the canonical forms.
 *
 * A canonical question is hashed into a stored fingerprint, so changing these
 * rules silently changes which old questions a new one matches. Every case
 * below is a decision; if one has to change, change it on purpose.
 */

const QUERY_GOLDENS: ReadonlyArray<[input: string, canonical: string]> = [
  ['What is a closure?', 'what is a closure'],
  ['what is a closure', 'what is a closure'],
  ['  WHAT   is a CLOSURE ?? ', 'what is a closure'],
  ['what is a closure.', 'what is a closure'],
  ['What\tis\na closure', 'what is a closure'],
  ['what—is—a—closure', 'what is a closure'],
  ['ｗｈａｔ　ｉｓ　ＪＳＯＮ', 'what is json'],
  ['Can you explain closures?', 'closures'],
  ['explain closures please', 'closures'],
  ['Please, can you explain closures?', 'closures'],
  ['Could you please explain recursion?', 'recursion'],
  ['explain: closures (in JS)', 'closures in js'],
  ['How do I reverse a list in Python?', 'reverse a list in python'],
  ['how do closures work', 'closures work'],
  ['How does a closure work?', 'how does a closure work'],
  ['hello, how do I center a div?', 'center a div'],
  ['Hey can you help me with SQL joins', 'with sql joins'],
  ['Tell me about RLS', 'about rls'],
  ['Help me debug this error', 'debug this error'],
  ['I want to learn React hooks', 'learn react hooks'],
  ['I would like to understand Docker', 'understand docker'],
  ['Thank you! What is Big-O?', 'what is big o'],
  ['pls fix my loop', 'fix my loop'],
  ['plz explain git rebase vs merge', 'git rebase vs merge'],
  ["What's the difference between let and const?", 'whats the difference between let and const'],
  ["don't use var", 'dont use var'],
  ['Qu’est-ce que React?', 'quest ce que react'],
  ['¿Qué es una clausura?', 'qué es una clausura'],
  ['Café au lait?', 'café au lait'],
  ['C++ templates explained', 'c++ templates explained'],
  ['C# async/await', 'c# async await'],
  ['Node.js event loop', 'node js event loop'],
  ['what is 2+2', 'what is 2+2'],
  ['SELECT * FROM users;', 'select from users'],
  ['why is my useEffect running twice', 'why is my useeffect running twice'],
  ['Explainability in ML', 'explainability in ml'],
  // Nothing but filler: no question at all, and must not fingerprint as one.
  ['thanks!', ''],
  ['please explain', ''],
  ['hi', ''],
  ['How do I how do I', ''],
  ['Can you can you explain', ''],
  ['', ''],
  ['   ', ''],
];

describe('canonicalizeQuery goldens', () => {
  it.each(QUERY_GOLDENS)('%j → %j', (input, expected) => {
    expect(canonicalizeQuery(input)).toBe(expected);
  });

  it('has at least forty goldens', () => {
    expect(QUERY_GOLDENS.length).toBeGreaterThanOrEqual(40);
  });

  it('collapses polite rephrasings of one question to one form', () => {
    const forms = new Set(
      ['Can you explain closures?', 'explain closures', 'Closures, please!', 'Could you please explain closures'].map(
        canonicalizeQuery,
      ),
    );
    expect([...forms]).toEqual(['closures']);
  });

  it('keeps questions that mean different things apart', () => {
    expect(canonicalizeQuery('what is a closure')).not.toBe(canonicalizeQuery('why is a closure'));
    expect(canonicalizeQuery('c++ templates')).not.toBe(canonicalizeQuery('c templates'));
  });

  it('is idempotent', () => {
    for (const [input] of QUERY_GOLDENS) {
      const once = canonicalizeQuery(input);
      expect(canonicalizeQuery(once)).toBe(once);
    }
  });
});

describe('canonicalizeConcept', () => {
  it.each([
    ['Closures', 'closures'],
    ['Row-Level Security', 'row-level-security'],
    ['row level security', 'row-level-security'],
    ['The event loop', 'event-loop'],
    ['an Event Loop', 'event-loop'],
    ['Node.js', 'node.js'],
    ['node js', 'node-js'],
    ['C++ templates', 'c++-templates'],
    ['C#', 'c#'],
    ['  Prompt   Caching ', 'prompt-caching'],
    ['Big-O notation.', 'big-o-notation'],
    ["Python's GIL", 'pythons-gil'],
    ['A', 'a'],
    ['...', ''],
    ['', ''],
  ])('%j → %j', (input, expected) => {
    expect(canonicalizeConcept(input)).toBe(expected);
  });

  it('caps a sentence-length label at a word boundary', () => {
    const key = canonicalizeConcept('word '.repeat(40));
    expect(key.length).toBeLessThanOrEqual(80);
    expect(key.endsWith('-')).toBe(false);
    expect(key.split('-').every((part) => part === 'word')).toBe(true);
  });
});

describe('word-overlap similarity', () => {
  it('ignores filler and question words', () => {
    expect([...tokenSet('What is a closure in JavaScript?')].sort()).toEqual(['closure', 'javascript']);
  });

  it('scores partial overlap as the share of distinct words in common', () => {
    const a = tokenSet('what is a closure in javascript');
    const b = tokenSet('closure in javascript explained');
    expect(jaccard(a, b)).toBeCloseTo(2 / 3, 10);
  });

  it('scores identical sets 1 and disjoint sets 0', () => {
    const a = tokenSet('python list comprehension');
    expect(jaccard(a, tokenSet('Python list comprehension?'))).toBe(1);
    expect(jaccard(a, tokenSet('rust borrow checker'))).toBe(0);
  });

  it('treats two empty questions as unrelated, not identical', () => {
    expect(jaccard(tokenSet('please'), tokenSet('thanks'))).toBe(0);
  });

  it('is symmetric', () => {
    const a = tokenSet('react state management with hooks');
    const b = tokenSet('managing state in react');
    expect(jaccard(a, b)).toBe(jaccard(b, a));
  });
});
