/**
 * Python regular expressions, compiled for JavaScript.
 *
 * The patterns in this package are copied verbatim from the Python gateway it
 * replaces, and Python reads several escapes differently: `\w`, `\d` and `\s`
 * are Unicode-aware there (so Urdu digits are digits, and `é` is a letter) but
 * ASCII-only here, and `.` stops only at `\n` there but at `\r`, U+2028 and
 * U+2029 here too. `pyRegex` rewrites those escapes, so each pattern matches
 * what it matched in Python and can stay as it was written.
 *
 * One deliberate difference: for `\b`, Korean, Chinese and Japanese characters
 * are not word characters. Korean attaches particles straight onto a word, as
 * in "FA21-BCS-123입니다", and under Python's rule the student-ID recognizer
 * found no word boundary after the ID and missed it.
 */

/** What Python's `\s` and `str.isspace()` match. */
export const PY_SPACE = String.raw`\t\n\v\f\r\x1c-\x1f \x85\xa0  -     　`;

const WORD = String.raw`\p{L}\p{N}_`;
const BOUNDARY_WORD = String.raw`(?:(?![\p{sc=Hangul}\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}])[${WORD}])`;
const BOUNDARY = `(?:(?<=${BOUNDARY_WORD})(?!${BOUNDARY_WORD})|(?<!${BOUNDARY_WORD})(?=${BOUNDARY_WORD}))`;

const OUTSIDE_CLASS: Record<string, string> = {
  w: `[${WORD}]`,
  W: `[^${WORD}]`,
  d: String.raw`\p{Nd}`,
  D: String.raw`\P{Nd}`,
  s: `[${PY_SPACE}]`,
  S: `[^${PY_SPACE}]`,
  b: BOUNDARY,
};

const INSIDE_CLASS: Record<string, string> = {
  w: WORD,
  d: String.raw`\p{Nd}`,
  s: PY_SPACE,
};

export interface PyRegexOptions {
  /** Python's `re.IGNORECASE`. */
  ignoreCase?: boolean;
  /** Python's `re.DOTALL`: `.` matches newlines too. */
  dotAll?: boolean;
  /** For `exec` loops, the equivalent of Python's `finditer`. */
  global?: boolean;
  /** Record group positions in `match.indices`, Python's `match.span(n)`. */
  indices?: boolean;
}

export function pyRegex(pattern: string, options: PyRegexOptions = {}): RegExp {
  let source = '';
  let inClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;

    if (char === '\\') {
      const next = pattern[++i] ?? '';
      const table = inClass ? INSIDE_CLASS : OUTSIDE_CLASS;
      if (next in table) {
        source += table[next];
      } else if (inClass && 'WDSB'.includes(next)) {
        // A negated class inside a class has no spelling without the `v` flag,
        // and that flag rejects punctuation these patterns leave unescaped.
        throw new Error(`pyRegex: \\${next} inside a character class is not supported`);
      } else {
        source += char + next;
      }
    } else if (inClass) {
      if (char === ']') inClass = false;
      source += char;
    } else if (char === '[') {
      inClass = true;
      source += char;
    } else if (char === '.' && !options.dotAll) {
      source += String.raw`[^\n]`;
    } else {
      source += char;
    }
  }

  const flags =
    'u' +
    (options.ignoreCase ? 'i' : '') +
    (options.dotAll ? 's' : '') +
    (options.global ? 'g' : '') +
    (options.indices ? 'd' : '');
  return new RegExp(source, flags);
}

/** `str.split()` with no separator: splits on runs of Python whitespace. */
export function pySplit(text: string): string[] {
  return text.split(new RegExp(`[${PY_SPACE}]+`, 'u')).filter(Boolean);
}

/**
 * Python's `round(x, 3)`.
 *
 * `toFixed` rounds the exact binary value, as Python does. The two disagree
 * only on exact binary ties such as 0.0625, which neither a probability nor a
 * sum of three-decimal scores lands on.
 */
export function round3(value: number): number {
  return Number(value.toFixed(3));
}
