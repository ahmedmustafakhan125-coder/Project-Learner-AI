/**
 * Person names.
 *
 * The Python gateway took these from spaCy's small English model, through
 * Presidio's SpacyRecognizer, at a fixed 0.85. Here they come from compromise's
 * name lexicon and grammar, at the same 0.85, kept only when they look like a
 * name rather than a word that happens to be one:
 *
 *   - at least one capitalised word ("buddy" and "will" are names too);
 *   - two words or more, or a known first name not written in capitals
 *     ("Markov chains" is not a person, and "DAN" is a jailbreak);
 *   - no hyphenated or acronym words, which in a programming course are almost
 *     always algorithms: Floyd-Warshall, Boyer-Moore.
 *
 * The two disagree at the edges. spaCy, an English model, also tagged runs of
 * Urdu and Korean words as names, which masked benign prompts in those
 * languages; compromise reads only Latin script and does not. Neither catches
 * every name.
 */

import nlp from 'compromise';

import type { Detection, Recognizer } from './types.js';

interface PersonTerm {
  text: string;
  tags: string[];
  offset: { start: number; length: number };
}

const CAPITALISED = /^\p{Lu}/u;
const POSSESSIVE = /['’]s$/u;

export const personRecognizer: Recognizer = {
  name: 'PersonRecognizer',
  context: [],
  analyze(text) {
    const people = nlp(text).people().json({ offset: true, terms: { offset: true } }) as Array<{ terms: PersonTerm[] }>;
    const found: Detection[] = [];
    for (const { terms } of people) {
      const first = terms[0];
      const last = terms[terms.length - 1];
      if (!first || !last) continue;
      if (!terms.some((term) => CAPITALISED.test(term.text))) continue;
      if (terms.length === 1 && (!first.tags.includes('FirstName') || first.text === first.text.toUpperCase())) continue;
      if (terms.some((term) => term.tags.includes('Hyphenated') || term.tags.includes('Acronym'))) continue;

      const start = first.offset.start;
      let end = last.offset.start + last.offset.length;
      // "Sarah's laptop": the name is Sarah.
      if (POSSESSIVE.test(text.slice(start, end))) end -= 2;
      found.push({ type: 'PERSON', start, end, score: 0.85, recognizer: personRecognizer });
    }
    return found;
  },
};
