/**
 * Policy engine: ALLOW, MASK or BLOCK.
 *
 *   final_risk = min(1, max(rule_score, semantic_score)
 *                       + 0.20 if any PII + 0.30 if a secret)
 *
 * BLOCK when final_risk reaches 0.70, or when any hard reason code is present
 * (secret or system-prompt extraction, jailbreak, safety bypass, RAG
 * manipulation, a semantic injection) whatever the score. MASK when PII is
 * present and nothing blocked. ALLOW otherwise.
 *
 * Thresholds and weights are the Python gateway's config/gateway_config.yaml.
 */

import { round3 } from './pyre.js';

export type Decision = 'ALLOW' | 'MASK' | 'BLOCK';

export const POLICY = {
  blockMin: 0.7,
  piiWeight: 0.2,
  secretWeight: 0.3,
  /** A semantic score at or above this adds SEMANTIC_INJECTION. */
  semanticBlock: 0.7,
} as const;

const HARD_BLOCK_REASONS = new Set([
  'RULE_SECRET_EXFIL',
  'RULE_SECRET_EXFIL_UR',
  'RULE_SECRET_EXFIL_KO',
  'RULE_SYSTEM_PROMPT_EXTRACTION',
  'RULE_SYSTEM_PROMPT_EXTRACTION_UR',
  'RULE_SYSTEM_PROMPT_EXTRACTION_KO',
  'RULE_JAILBREAK',
  'RULE_BYPASS_SAFETY',
  'RULE_RAG_MANIPULATION',
  'SEMANTIC_INJECTION',
]);

export interface PolicyInput {
  ruleScore: number;
  semanticScore: number;
  hasPii: boolean;
  hasSecret: boolean;
  reasonCodes: string[];
  maskedText: string;
  originalText: string;
}

export interface PolicyResult {
  decision: Decision;
  finalRisk: number;
  /** What may be sent onward: null on BLOCK, the masked text on MASK. */
  safeText: string | null;
  reasonCodes: string[];
}

export function computeFinalRisk(ruleScore: number, semanticScore: number, hasPii: boolean, hasSecret: boolean): number {
  const total =
    Math.max(ruleScore, semanticScore) + (hasPii ? POLICY.piiWeight : 0) + (hasSecret ? POLICY.secretWeight : 0);
  return round3(Math.min(total, 1));
}

export function decide(input: PolicyInput): PolicyResult {
  const finalRisk = computeFinalRisk(input.ruleScore, input.semanticScore, input.hasPii, input.hasSecret);
  const reasonCodes = input.reasonCodes;

  if (finalRisk >= POLICY.blockMin || reasonCodes.some((code) => HARD_BLOCK_REASONS.has(code))) {
    return { decision: 'BLOCK', finalRisk, safeText: null, reasonCodes };
  }
  if (input.hasPii) {
    const withPii = reasonCodes.includes('PII_DETECTED') ? reasonCodes : [...reasonCodes, 'PII_DETECTED'];
    return { decision: 'MASK', finalRisk, safeText: input.maskedText, reasonCodes: withPii };
  }
  return { decision: 'ALLOW', finalRisk, safeText: input.originalText, reasonCodes };
}
