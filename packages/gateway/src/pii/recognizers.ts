/**
 * The pattern-based recognizers: Presidio's built-in email, credit card and
 * US SSN recognizers, and the four the Python gateway added (API keys,
 * Pakistani phone numbers, CNICs and student IDs). Patterns, scores and
 * context words are Presidio's and the gateway's, unchanged.
 */

import { parse } from 'tldts';

import { pyRegex } from '../pyre.js';
import { removeDuplicates, type Detection, type EntityType, type Recognizer } from './types.js';

interface PatternRecognizerSpec {
  name: string;
  type: EntityType;
  patterns: Array<[pattern: string, score: number]>;
  context: string[];
  /** Presidio's `validate_result`: true raises the score to 1, false drops the match. */
  validate?: (match: string) => boolean;
  /** Presidio's `invalidate_result`: true drops the match. */
  invalidate?: (match: string) => boolean;
}

/** Presidio's PatternRecognizer, which matches with IGNORECASE and DOTALL. */
function patternRecognizer(spec: PatternRecognizerSpec): Recognizer {
  const patterns = spec.patterns.map(([pattern, score]) => ({
    regex: pyRegex(pattern, { ignoreCase: true, dotAll: true, global: true }),
    score,
  }));
  const recognizer: Recognizer = {
    name: spec.name,
    context: spec.context,
    analyze(text) {
      const found: Detection[] = [];
      for (const { regex, score } of patterns) {
        for (const match of text.matchAll(regex)) {
          const value = match[0];
          if (!value) continue;
          let final = score;
          if (spec.validate) final = spec.validate(value) ? 1 : 0;
          if (spec.invalidate?.(value)) final = 0;
          if (final > 0) {
            found.push({ type: spec.type, start: match.index, end: match.index + value.length, score: final, recognizer });
          }
        }
      }
      return removeDuplicates(found);
    },
  };
  return recognizer;
}

/* ------------------------------------------------------------------ *
 * Presidio's built-ins
 * ------------------------------------------------------------------ */

/**
 * tldextract's check, as Presidio uses it: the address must end in a domain
 * registered under a real public suffix, so "a@b.c" and "user@localhost" are
 * not emails. Hostname syntax is not checked, as tldextract does not check it.
 */
function hasRegisteredDomain(email: string): boolean {
  const host = email.slice(email.lastIndexOf('@') + 1);
  const parsed = parse(host, { allowPrivateDomains: false, validateHostname: false });
  return Boolean(parsed.domain) && parsed.isIcann === true;
}

// `\x60` is a backtick, which Presidio's pattern has unescaped.
const EMAIL_LOCAL_CHAR = String.raw`[!#$%&'*+\-/=?^_\x60{|}~\w]`;
const EMAIL_LOCAL_INNER = String.raw`[!#$%&'*+\-/=?^_\x60{|}~\.\w]`;

export const emailRecognizer = patternRecognizer({
  name: 'EmailRecognizer',
  type: 'EMAIL_ADDRESS',
  patterns: [
    [
      String.raw`\b(((${EMAIL_LOCAL_CHAR})|(${EMAIL_LOCAL_CHAR}${EMAIL_LOCAL_INNER}{0,}${EMAIL_LOCAL_CHAR}))[@]\w+([-.]\w+)*\.\w+([-.]\w+)*)\b`,
      0.5,
    ],
  ],
  context: ['email'],
  validate: hasRegisteredDomain,
});

/** Python's int() of a decimal digit in any script: runs of ten start at 0. */
function digitValue(char: string): number {
  const code = char.codePointAt(0)!;
  let start = code;
  while (/^\p{Nd}$/u.test(String.fromCodePoint(start - 1))) start--;
  return (code - start) % 10;
}

function passesLuhn(digits: string): boolean {
  const values = Array.from(digits, digitValue).reverse();
  let sum = 0;
  values.forEach((value, i) => {
    if (i % 2 === 0) sum += value;
    else sum += Math.floor((value * 2) / 10) + ((value * 2) % 10);
  });
  return sum % 10 === 0;
}

export const creditCardRecognizer = patternRecognizer({
  name: 'CreditCardRecognizer',
  type: 'CREDIT_CARD',
  patterns: [
    [String.raw`\b((4\d{3})|(5[0-5]\d{2})|(6\d{3})|(1\d{3})|(3\d{3}))[- ]?(\d{3,4})[- ]?(\d{3,4})[- ]?(\d{3,5})\b`, 0.3],
  ],
  context: ['credit', 'card', 'visa', 'mastercard', 'cc ', 'amex', 'discover', 'jcb', 'diners', 'maestro', 'instapayment'],
  validate: (match) => passesLuhn(match.replaceAll('-', '').replaceAll(' ', '')),
});

export const ssnRecognizer = patternRecognizer({
  name: 'UsSsnRecognizer',
  type: 'US_SSN',
  patterns: [
    [String.raw`\b([0-9]{5})-([0-9]{4})\b`, 0.05],
    [String.raw`\b([0-9]{3})-([0-9]{6})\b`, 0.05],
    [String.raw`\b(([0-9]{3})-([0-9]{2})-([0-9]{4}))\b`, 0.05],
    [String.raw`\b[0-9]{9}\b`, 0.05],
    [String.raw`\b([0-9]{3})[- .]([0-9]{2})[- .]([0-9]{4})\b`, 0.5],
  ],
  context: ['social', 'security', 'ssn', 'ssns', 'ssn#', 'ss#', 'ssid'],
  invalidate(match) {
    // Mixed delimiters, one repeated digit, an all-zero group, or a famous sample.
    if (new Set(match.match(/[.\- ]/g)).size > 1) return true;
    const digits = match.replace(/\D/g, '');
    if ([...digits].every((d) => d === digits[0])) return true;
    if (digits.slice(3, 5) === '00' || digits.slice(5) === '0000') return true;
    return ['000', '666', '123456789', '98765432', '078051120'].some((sample) => digits.startsWith(sample));
  },
});

/* ------------------------------------------------------------------ *
 * The gateway's own
 * ------------------------------------------------------------------ */

/** OpenAI, Google, Bearer tokens, and any long random-looking secret. */
export const apiKeyRecognizer = patternRecognizer({
  name: 'ApiKeyRecognizer',
  type: 'API_KEY',
  patterns: [
    [String.raw`sk-[a-zA-Z0-9]{20,}`, 0.9],
    [String.raw`AIza[0-9A-Za-z\-_]{35}`, 0.9],
    [String.raw`Bearer\s+[a-zA-Z0-9\-_\.]{20,}`, 0.85],
    [String.raw`\b[a-zA-Z0-9_\-]{32,}\b`, 0.55],
  ],
  context: ['api', 'key', 'token', 'secret', 'credential', 'auth', 'authorization', 'bearer'],
});

/** Pakistani formats: +92…, 03XX…, and a bare 92…. */
export const pakistaniPhoneRecognizer = patternRecognizer({
  name: 'PakistaniPhoneRecognizer',
  type: 'PHONE_NUMBER',
  patterns: [
    [String.raw`\+92[-\s]?[0-9]{3}[-\s]?[0-9]{7}`, 0.85],
    [String.raw`\b03[0-9]{2}[-\s]?[0-9]{7}\b`, 0.85],
    [String.raw`(?<!\d)92[0-9]{10}(?!\d)`, 0.75],
  ],
  context: ['phone', 'mobile', 'call', 'contact', 'whatsapp', 'number', 'reach', 'dial', 'فون', 'موبائل', 'نمبر', '전화', '휴대전화'],
});

/** Pakistani CNIC: five digits, seven digits, one digit. */
export const cnicRecognizer = patternRecognizer({
  name: 'CnicRecognizer',
  type: 'CNIC',
  patterns: [[String.raw`\b\d{5}-\d{7}-\d\b`, 0.95]],
  context: ['cnic', 'id', 'national', 'identity', 'شناختی', '카드'],
});

/** University student IDs such as FA21-BCS-123 or SP20-BSE-045. */
export const studentIdRecognizer = patternRecognizer({
  name: 'StudentIdRecognizer',
  type: 'STUDENT_ID',
  patterns: [[String.raw`\b[A-Z]{2}\d{2}-[A-Z]{2,4}-\d{2,4}\b`, 0.9]],
  context: ['student', 'id', 'registration', 'reg', 'roll', 'طالب', '학생'],
});
