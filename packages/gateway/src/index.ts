/**
 * The LLM security gateway: screens a prompt and decides ALLOW, MASK or BLOCK.
 *
 *   1. Language detection
 *   2. Rule-based injection detection (English, Urdu, Korean, obfuscation)
 *   3. Semantic injection detection (TF-IDF + logistic regression)
 *   4. PII analysis and anonymization
 *   5. Policy: ALLOW, MASK or BLOCK
 *
 * A TypeScript port of the Python service (FastAPI, Presidio, spaCy,
 * scikit-learn) that used to run beside the API, so the API now screens in
 * process. Detection rules, weights and thresholds are unchanged; where the
 * port behaves differently, the module concerned says so. README.md has the
 * evaluation figures for both.
 */

import { randomUUID } from 'node:crypto';

import { trainingRows } from './data.js';
import { detectLanguage, isMixedLanguage, type Language } from './language.js';
import { analyzePii, type EntityType, type PiiEntity } from './pii/index.js';
import { decide, POLICY, type Decision } from './policy.js';
import { round3 } from './pyre.js';
import { scoreRules } from './rules.js';
import { semanticProbability, trainSemanticModel, type SemanticModel } from './semantic.js';

export type { Decision, EntityType, Language, PiiEntity };

export interface Analysis {
  inputId: string;
  language: Language;
  ruleScore: number;
  semanticScore: number;
  piiEntities: PiiEntity[];
  finalRisk: number;
  decision: Decision;
  /** What may be sent onward: null on BLOCK, the masked text on MASK, the input on ALLOW. */
  safeText: string | null;
  reasonCodes: string[];
  latencyMs: number;
}

export interface AnalyzeOptions {
  /** Ties the decision to the request that caused it, in logs. */
  inputId?: string;
  /** False skips the semantic detector; the evaluation compares the two. */
  useSemantic?: boolean;
}

let model: SemanticModel | null = null;

function semanticModel(): SemanticModel {
  model ??= trainSemanticModel(trainingRows());
  return model;
}

/**
 * Trains the semantic model and loads the name lexicon now, rather than on the
 * first prompt. Call it at startup, so a missing data file stops the process
 * instead of failing every screened request.
 */
export function prepare(): void {
  semanticModel();
  analyzePii('Ali Khan');
}

export function analyze(text: string, options: AnalyzeOptions = {}): Analysis {
  const startedAt = performance.now();
  const inputId = options.inputId ?? `case_${randomUUID().replaceAll('-', '').slice(0, 8)}`;

  const language = detectLanguage(text);
  const mixed = isMixedLanguage(text);
  const rules = scoreRules(text);
  const semanticScore = options.useSemantic === false ? 0 : round3(semanticProbability(semanticModel(), text));
  const pii = analyzePii(text);

  const reasons = [...rules.reasons];
  if (semanticScore >= POLICY.semanticBlock) reasons.push('SEMANTIC_INJECTION');
  if (pii.compositePii) reasons.push('COMPOSITE_PII');
  if (mixed) reasons.push('MIXED_LANGUAGE');
  if (pii.hasSecret) reasons.push('SECRET_REFERENCE');

  const policy = decide({
    ruleScore: rules.score,
    semanticScore,
    hasPii: pii.entities.length > 0,
    hasSecret: pii.hasSecret,
    reasonCodes: reasons,
    maskedText: pii.maskedText,
    originalText: text,
  });

  return {
    inputId,
    language,
    ruleScore: rules.score,
    semanticScore,
    piiEntities: pii.entities,
    finalRisk: policy.finalRisk,
    decision: policy.decision,
    safeText: policy.safeText,
    reasonCodes: policy.reasonCodes,
    latencyMs: Number((performance.now() - startedAt).toFixed(2)),
  };
}

export interface AuditRecord {
  inputId: string;
  language: Language;
  ruleScore: number;
  semanticScore: number;
  /** Types and scores only: matched text, which may be a secret, is never logged. */
  piiEntities: Array<{ type: EntityType; score: number }>;
  finalRisk: number;
  decision: Decision;
  reasonCodes: string[];
  latencyMs: number;
}

/** The Python gateway's audit-log line for a decision. */
export function auditRecord(analysis: Analysis): AuditRecord {
  return {
    inputId: analysis.inputId,
    language: analysis.language,
    ruleScore: analysis.ruleScore,
    semanticScore: analysis.semanticScore,
    piiEntities: analysis.piiEntities.map(({ type, score }) => ({ type, score })),
    finalRisk: analysis.finalRisk,
    decision: analysis.decision,
    reasonCodes: analysis.reasonCodes,
    latencyMs: analysis.latencyMs,
  };
}
