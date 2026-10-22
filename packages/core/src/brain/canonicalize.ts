/**
 * Canonical forms, for matching questions and concepts without embeddings.
 *
 * Two learners never type a question the same way, and one learner rarely
 * types it the same way twice: "Can you explain closures?" and "explain
 * closures please" are the same question. Canonicalising strips what carries
 * no meaning — case, punctuation, politeness, the "how do I" scaffolding —
 * and what is left is compared exactly (fingerprints) or by word overlap
 * (`jaccard`).
 *
 * Everything here is pure and deterministic. The canonical form is hashed into
 * a fingerprint that is stored, so changing these rules changes which old
 * questions match new ones — the golden tests exist to make that deliberate.
 */

/**
 * Filler phrases dropped from questions, longest first so "how do i" wins over
 * "how do". Matched as whole token sequences, never as substrings: "explain"
 * goes, "explainability" stays.
 */
const QUERY_STOP_PHRASES: readonly (readonly string[])[] = [
  ['can', 'you', 'please'],
  ['could', 'you', 'please'],
  ['how', 'do', 'i'],
  ['i', 'want', 'to'],
  ['i', 'would', 'like', 'to'],
  ['thank', 'you'],
  ['can', 'you'],
  ['could', 'you'],
  ['would', 'you'],
  ['how', 'do'],
  ['tell', 'me'],
  ['help', 'me'],
  ['explain'],
  ['please'],
  ['pls'],
  ['plz'],
  ['thanks'],
  ['hey'],
  ['hi'],
  ['hello'],
].sort((a, b) => b.length - a.length);

/**
 * Words too common to say anything about which question was asked. Used only
 * for word-overlap similarity, never for the canonical form itself — the
 * canonical form must keep "what is" vs "why is" distinct.
 */
const OVERLAP_STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on', 'at', 'for',
  'and', 'or', 'it', 'its', 'this', 'that', 'with', 'as', 'by', 'from', 'my', 'me', 'i',
  'you', 'your', 'we', 'do', 'does', 'did', 'what', 'how', 'why', 'when', 'where', 'which',
  'who', 'can', 'could', 'would', 'should', 'will', 'about', 'into', 'some', 'any',
]);

/** Letters and digits in any script, plus `+` and `#` so C++ and C# survive. */
const NON_WORD = /[^\p{L}\p{N}+#]+/gu;

/** Lowercased, NFKC-normalised word tokens. Apostrophes join: "don't" → "dont". */
function words(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(NON_WORD, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

function dropStopPhrases(tokens: readonly string[]): string[] {
  const out: string[] = [];
  let i = 0;
  outer: while (i < tokens.length) {
    for (const phrase of QUERY_STOP_PHRASES) {
      if (phrase.every((word, j) => tokens[i + j] === word)) {
        i += phrase.length;
        continue outer;
      }
    }
    out.push(tokens[i] as string);
    i += 1;
  }
  return out;
}

/**
 * The canonical form of a learner's question.
 *
 * Returns an empty string when nothing but filler was typed ("please explain"),
 * and callers must treat that as "no fingerprint" rather than as a question
 * every other empty question matches.
 */
export function canonicalizeQuery(text: string): string {
  return dropStopPhrases(words(text)).join(' ');
}

/** Leading articles carry nothing in a concept name: "The event loop" is "event loop". */
const CONCEPT_ARTICLES = new Set(['a', 'an', 'the']);

/** Longest concept key kept. Longer labels are sentences, not concept names. */
const MAX_CONCEPT_KEY = 80;

/**
 * The identity of a concept: lowercase words joined by hyphens.
 *
 * "Row-Level Security", "row level security" and "The row level security"
 * are one concept, `row-level-security`. Dots are kept inside a word so
 * "Node.js" does not collapse into "node-js" alongside an unrelated "node js".
 */
export function canonicalizeConcept(label: string): string {
  const tokens = label
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}+#.]+/gu, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t.length > 0);

  while (tokens.length > 1 && CONCEPT_ARTICLES.has(tokens[0] as string)) tokens.shift();

  let key = tokens.join('-');
  if (key.length > MAX_CONCEPT_KEY) {
    key = key.slice(0, MAX_CONCEPT_KEY).replace(/-[^-]*$/, '');
  }
  return key;
}

/**
 * A deliberately crude stemmer: a trailing plural `s` goes, so "closures" and
 * "closure" compare equal. It will also turn "redis" into "redi", which is
 * harmless — both sides of every comparison are stemmed the same way. Anything
 * cleverer starts rewriting identifiers like "useEffect". Used only for
 * overlap; the canonical form and its fingerprint keep every word as typed.
 */
function stem(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

/** The meaningful words of a text, for overlap comparison. */
export function tokenSet(text: string): Set<string> {
  return new Set(
    canonicalizeQuery(text)
      .split(' ')
      .filter((w) => w.length >= 2 && !OVERLAP_STOPWORDS.has(w))
      .map(stem),
  );
}

/**
 * Word-overlap similarity, |A ∩ B| / |A ∪ B|, in [0, 1].
 *
 * Two empty sets score 0, not 1: two questions that said nothing are not the
 * same question.
 */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}
