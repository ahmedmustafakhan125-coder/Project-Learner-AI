/**
 * Context-aware scoring, as Presidio's LemmaContextAwareEnhancer does it.
 *
 * A detection whose recognizer lists context words gains 0.35 (to at least
 * 0.4, at most 1) when one of those words occurs inside a word near it: the
 * detection's own token plus the five keywords before it. Keywords are the
 * tokens that are neither stop words nor punctuation.
 *
 * Presidio takes tokens and lemmas from spaCy. Here a token is a run of
 * non-space characters with punctuation split off either end, and its lemma is
 * its lowercase form. Context words match as substrings ("card" in "cards"),
 * which makes lemmatisation matter little.
 *
 * The gateway also passes EXTRA_CONTEXT, which Presidio appends to every
 * detection's nearby words. Any recognizer whose context words appear in that
 * list is therefore boosted unconditionally: email, phone, API key, CNIC and
 * student ID all are. Only credit cards, IBANs and SSNs depend on the text.
 */

import type { Detection } from './types.js';

export const EXTRA_CONTEXT = [
  'email', 'e-mail', 'mail', 'phone', 'mobile', 'number', 'cnic',
  'student', 'id', 'api', 'key', 'token', 'secret', 'password',
  'credential', 'ایمیل', 'فون', 'نمبر', '이메일', '비밀번호', '전화',
];

const CONTEXT_FACTOR = 0.35;
const MIN_SCORE_WITH_CONTEXT = 0.4;
const PREFIX_KEYWORDS = 5;

/** spaCy's English stop words. */
const STOP_WORDS = new Set(
  `'d 'll 'm 're 's 've a about above across after afterwards again against all almost alone along
  already also although always am among amongst amount an and another any anyhow anyone anything
  anyway anywhere are around as at back be became because become becomes becoming been before
  beforehand behind being below beside besides between beyond both bottom but by ca call can
  cannot could did do does doing done down due during each eight either eleven else elsewhere
  empty enough even ever every everyone everything everywhere except few fifteen fifty first five
  for former formerly forty four from front full further get give go had has have he hence her
  here hereafter hereby herein hereupon hers herself him himself his how however hundred i if in
  indeed into is it its itself just keep last latter latterly least less made make many may me
  meanwhile might mine more moreover most mostly move much must my myself n't name namely neither
  never nevertheless next nine no nobody none noone nor not nothing now nowhere n‘t n’t of off
  often on once one only onto or other others otherwise our ours ourselves out over own part per
  perhaps please put quite rather re really regarding same say see seem seemed seeming seems
  serious several she should show side since six sixty so some somehow someone something sometime
  sometimes somewhere still such take ten than that the their them themselves then thence there
  thereafter thereby therefore therein thereupon these they third this those though three through
  throughout thru thus to together too top toward towards twelve twenty two under unless until up
  upon us used using various very via was we well were what whatever when whence whenever where
  whereafter whereas whereby wherein whereupon wherever whether which while whither who whoever
  whole whom whose why will with within without would yet you your yours yourself yourselves ‘d
  ‘ll ‘m ‘re ‘s ‘ve ’d ’ll ’m ’re ’s ’ve`.split(/\s+/),
);

interface Token {
  word: string;
  start: number;
  end: number;
}

const CHUNK = /\S+/gu;
const EDGE_PUNCTUATION = /^(\p{P}*)(.*?)(\p{P}*)$/su;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const chunk of text.matchAll(CHUNK)) {
    const [, lead = '', core = '', trail = ''] = EDGE_PUNCTUATION.exec(chunk[0])!;
    let start = chunk.index;
    for (const part of [...lead, core, ...trail]) {
      if (!part) continue;
      tokens.push({ word: part, start, end: start + part.length });
      start += part.length;
    }
  }
  return tokens;
}

function isKeyword(word: string): boolean {
  const lower = word.toLowerCase();
  return !STOP_WORDS.has(lower) && !/^\p{P}+$/u.test(word) && lower !== 'be';
}

/** The detection's own token and the keywords before it, lowercased. */
function nearbyWords(tokens: Token[], start: number): string[] {
  // The token at the detection's start, or the first one after it.
  let index = tokens.findIndex((token) => token.start === start || start < token.end);
  if (index < 0) return [];
  const words = new Set<string>();
  for (let remaining = PREFIX_KEYWORDS + 1; index >= 0 && remaining > 0; index--) {
    const word = tokens[index]!.word;
    if (!isKeyword(word)) continue;
    words.add(word.toLowerCase());
    remaining--;
  }
  return [...words];
}

export function enhanceUsingContext(text: string, detections: Detection[]): void {
  const tokens = tokenize(text);
  for (const detection of detections) {
    const context = detection.recognizer.context;
    if (context.length === 0) continue;
    const words = [...nearbyWords(tokens, detection.start), ...EXTRA_CONTEXT];
    if (!context.some((cue) => words.some((word) => word.includes(cue)))) continue;
    detection.score = Math.min(Math.max(detection.score + CONTEXT_FACTOR, MIN_SCORE_WITH_CONTEXT), 1);
  }
}
