/**
 * Multilingual rule-based injection detector.
 *
 * A list of patterns per language, plus an obfuscation pass that undoes
 * leet-speak and strips punctuation before matching the English patterns
 * again. The score is the highest weight that matched, plus 0.05 for every
 * further match, so "ignore instructions" together with "reveal the system
 * prompt" outscores either alone.
 *
 * The patterns, weights and scoring are the Python gateway's, unchanged: the
 * policy thresholds and the evaluation figures were tuned against them. That
 * includes a quirk worth knowing: any punctuation at all makes the cleaned text
 * differ from the original, so a sentence ending in "." that matches a pattern
 * matches it twice and is also tagged RULE_OBFUSCATED.
 */

import { pyRegex, pySplit, PY_SPACE, round3 } from './pyre.js';

interface Rule {
  pattern: RegExp;
  code: string;
  weight: number;
}

function en(pattern: string, code: string, weight: number): Rule {
  return { pattern: pyRegex(pattern, { ignoreCase: true }), code, weight };
}

function other(pattern: string, code: string, weight: number): Rule {
  return { pattern: pyRegex(pattern), code, weight };
}

const EN_RULES: Rule[] = [
  en(String.raw`ignore\s+(previous|all|prior|earlier)\s+(instructions?|prompts?|rules?)`, 'RULE_IGNORE_INSTRUCTIONS', 0.8),
  en(String.raw`(disregard|forget)\s+(your|the|all|any)\s+(instructions?|rules?|guidelines?)`, 'RULE_DISREGARD_RULES', 0.8),
  en(String.raw`pretend\s+(you\s+are|to\s+be)`, 'RULE_PRETEND_ROLEPLAY', 0.7),
  en(String.raw`\bDAN\b`, 'RULE_DAN', 0.75),
  en(String.raw`\bjailbreak\b`, 'RULE_JAILBREAK', 0.85),
  en(String.raw`\bact\s+as\b.*(unrestricted|no\s+rules|anything)`, 'RULE_JAILBREAK_ROLEPLAY', 0.75),
  en(String.raw`bypass\s+(safety|filter|restriction|policy|guideline)`, 'RULE_BYPASS_SAFETY', 0.85),
  en(String.raw`override\s+system`, 'RULE_OVERRIDE_SYSTEM', 0.8),
  en(
    String.raw`(reveal|show|print|leak|expose)\s+(the\s+)?(system\s+prompt|hidden\s+(prompt|config|configuration|instruction)|your\s+prompt)`,
    'RULE_SYSTEM_PROMPT_EXTRACTION',
    0.9,
  ),
  en(String.raw`developer\s+mode`, 'RULE_DEVELOPER_MODE', 0.7),
  en(String.raw`(no\s+restrictions?|unrestricted\s+(assistant|mode))`, 'RULE_NO_RESTRICTIONS', 0.65),
  en(String.raw`print\s+(any\s+)?(api\s+keys?|passwords?|tokens?|secrets?)`, 'RULE_SECRET_EXFIL', 0.9),
  en(String.raw`(email|send|leak)\s+.{0,40}\b(prompt|password|api\s+key|token|secret)`, 'RULE_SECRET_EXFIL', 0.85),
  en(String.raw`use\s+the\s+retrieved\s+document\s+as\s+(a\s+)?system\s+instruction`, 'RULE_RAG_MANIPULATION', 0.85),
  en(String.raw`override\s+(your|the)\s+policy`, 'RULE_RAG_MANIPULATION', 0.8),
  en(String.raw`you\s+are\s+now\s+(a|an)\s+\w+`, 'RULE_PERSONA_HIJACK', 0.55),
];

// Urdu: ignore previous instructions, show the system prompt, leak a password
// or API key, and so on.
const UR_RULES: Rule[] = [
  other(String.raw`نظر\s*انداز`, 'RULE_INJECTION_UR_IGNORE', 0.8),
  other(String.raw`(پچھلی|پہلے\s*والی|سابقہ)\s*(ہدایات|احکامات)`, 'RULE_INJECTION_UR_PREVIOUS_RULES', 0.8),
  other(String.raw`سسٹم\s*پرامپٹ`, 'RULE_SYSTEM_PROMPT_EXTRACTION_UR', 0.85),
  other(String.raw`(دکھائیں|دکھاؤ|ظاہر\s*کریں)`, 'RULE_INJECTION_UR_SHOW', 0.55),
  other(String.raw`(پاس\s*ورڈ|API\s*کلید|خفیہ\s*کلید|ٹوکن)`, 'RULE_SECRET_EXFIL_UR', 0.85),
  other(String.raw`بھول\s*جاؤ`, 'RULE_INJECTION_UR_FORGET', 0.75),
];

const KO_RULES: Rule[] = [
  other(String.raw`이전\s*지침`, 'RULE_INJECTION_KO_PREVIOUS_RULES', 0.8),
  other(String.raw`무시(하고|해|하라|하세요)`, 'RULE_INJECTION_KO_IGNORE', 0.8),
  other(String.raw`시스템\s*프롬프트`, 'RULE_SYSTEM_PROMPT_EXTRACTION_KO', 0.85),
  other(String.raw`(보여|보여주|보여주세요|공개)`, 'RULE_INJECTION_KO_SHOW', 0.55),
  other(String.raw`(비밀번호|API\s*키|토큰|비밀)`, 'RULE_SECRET_EXFIL_KO', 0.85),
  other(String.raw`잊어`, 'RULE_INJECTION_KO_FORGET', 0.7),
];

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '!': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };
const LEET_CHARS = /[01!3457@$]/g;
const NOT_ALNUM_OR_SPACE = new RegExp(`[^A-Za-z0-9${PY_SPACE}]`, 'gu');

/** Undo leet-speak, then reduce everything but letters and digits to single spaces. */
function deobfuscate(text: string): string {
  const cleaned = text.replace(LEET_CHARS, (c) => LEET[c]!).replace(NOT_ALNUM_OR_SPACE, ' ');
  return pySplit(cleaned).join(' ');
}

export interface RuleResult {
  /** In [0, 1], rounded to three places. */
  score: number;
  reasons: string[];
}

export function scoreRules(text: string): RuleResult {
  const reasons: string[] = [];
  const weights: number[] = [];
  const hit = (rule: Rule) => {
    weights.push(rule.weight);
    if (!reasons.includes(rule.code)) reasons.push(rule.code);
  };

  // Python's case-insensitive matching also equates i with the Turkish dotless
  // ı and dotted İ; JavaScript's does not, and "ıgnore" would slip past.
  const caseless = text.replace(/[ıİ]/g, 'i');
  for (const rule of EN_RULES) if (rule.pattern.test(caseless)) hit(rule);
  for (const rule of [...UR_RULES, ...KO_RULES]) if (rule.pattern.test(text)) hit(rule);

  const cleaned = deobfuscate(text);
  if (cleaned && cleaned.toLowerCase() !== text.toLowerCase()) {
    for (const rule of EN_RULES) {
      if (!rule.pattern.test(cleaned)) continue;
      weights.push(rule.weight);
      if (!reasons.includes('RULE_OBFUSCATED')) reasons.push('RULE_OBFUSCATED');
      if (!reasons.includes(rule.code)) reasons.push(rule.code);
    }
  }

  if (weights.length === 0) return { score: 0, reasons: [] };
  const score = Math.min(Math.max(...weights) + 0.05 * (weights.length - 1), 1);
  return { score: round3(score), reasons };
}
