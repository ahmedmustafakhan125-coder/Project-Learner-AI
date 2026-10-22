import { analyze, auditRecord, type Analysis, type AuditRecord } from '@ai-edu/gateway';

/**
 * The LLM security gateway.
 *
 * Every piece of learner-supplied text is screened here before it can reach a
 * model. The screening is `@ai-edu/gateway`, run in this process: rule-based
 * detection, a semantic classifier and PII analysis, then a decision.
 *
 * Two things this module is responsible for, neither of which belongs in a
 * route:
 *
 *   1. **One failure policy.** Screening sits in front of anything that spends
 *      money or reaches a model, so "what if screening fails" has to be
 *      answered once, here, rather than per route where it would drift.
 *   2. **An audit trail.** Every decision is reported, with the request's input
 *      id and without the text, so it can be traced back to what caused it;
 *      so is every failure to screen, with the error behind it.
 *
 * It deliberately lives in `apps/api` and not in `packages/core`: core must stay
 * portable to React Native, where the screening package, which reads its
 * training data from disk, does not belong. Core sees only already-screened text.
 */

/* ------------------------------------------------------------------ *
 * Contract
 * ------------------------------------------------------------------ */

export type GatewayDecision = 'ALLOW' | 'MASK' | 'BLOCK';

export interface GatewayVerdict {
  decision: GatewayDecision;
  /** Text to actually send onward. For MASK this carries the redactions. */
  safeText: string;
  /** Machine-readable reasons, e.g. RULE_JAILBREAK, SEMANTIC_INJECTION, PII_DETECTED. */
  reasonCodes: string[];
  finalRisk: number | null;
  /** True when the text could not be screened at all. */
  unscreened: boolean;
}

/**
 * Where a screening call is happening, which decides what a screening failure means.
 *
 * `model-bound` covers anything whose next step is an LLM call. Those fail
 * closed: an unscreened prompt must never reach a model, and refusing is
 * recoverable in a way an injected prompt is not.
 *
 * `read` covers everything else. Those fail open so a screening failure
 * degrades the security layer rather than taking the whole platform offline.
 */
export type ScreenContext = 'model-bound' | 'read';

/** Thrown when a prompt is refused, or when a model-bound call cannot be screened. */
export class GatewayBlockedError extends Error {
  readonly reasonCodes: string[];
  readonly unscreened: boolean;

  constructor(message: string, reasonCodes: string[], unscreened = false) {
    super(message);
    this.name = 'GatewayBlockedError';
    this.reasonCodes = reasonCodes;
    this.unscreened = unscreened;
  }
}

/* ------------------------------------------------------------------ *
 * Screening
 * ------------------------------------------------------------------ */

export interface ScreeningReporter {
  /** One audit record per decision. */
  decision(record: AuditRecord): void;
  /** Screening threw: a bug or a broken install. The refusal alone does not say which. */
  failure(inputId: string, err: unknown): void;
}

let reporter: ScreeningReporter | null = null;

/** Where decisions and failures are reported; the server points this at its log. */
export function reportScreeningTo(next: ScreeningReporter): void {
  reporter = next;
}

/**
 * Screen one piece of text.
 *
 * `inputId` goes into the decision's audit record, so a decision can be traced
 * back to the request that caused it.
 */
export async function screen(
  text: string,
  inputId: string,
  context: ScreenContext = 'model-bound',
): Promise<GatewayVerdict> {
  // Empty input cannot carry an injection and is not worth analysing.
  if (!text.trim()) {
    return { decision: 'ALLOW', safeText: text, reasonCodes: [], finalRisk: null, unscreened: false };
  }

  let analysis: Analysis;
  try {
    analysis = analyze(text, { inputId });
  } catch (err) {
    reporter?.failure(inputId, err);
    return unavailable(context, `security gateway failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  reporter?.decision(auditRecord(analysis));

  const { decision, reasonCodes, finalRisk } = analysis;
  if (decision === 'BLOCK') {
    return { decision, safeText: '', reasonCodes, finalRisk, unscreened: false };
  }
  // MASK always carries the redacted text. Were it ever missing, the original
  // would not be a safe fallback: it is precisely the text that needed changing.
  if (analysis.safeText === null) {
    return unavailable(context, 'security gateway returned no safe text');
  }
  return { decision, safeText: analysis.safeText, reasonCodes, finalRisk, unscreened: false };
}

/** One place to decide what a screening failure means. */
function unavailable(context: ScreenContext, detail: string): GatewayVerdict {
  if (context === 'model-bound') {
    throw new GatewayBlockedError(detail, ['gateway_unavailable'], true);
  }
  return {
    decision: 'ALLOW',
    safeText: '',
    reasonCodes: ['gateway_unavailable'],
    finalRisk: null,
    unscreened: true,
  };
}

/**
 * Screen text that is about to reach a model, returning what should be sent.
 *
 * Throws `GatewayBlockedError` on BLOCK, and on any failure to screen — routes
 * turn that into a 422 rather than calling a provider.
 */
export async function screenOrThrow(text: string, inputId: string): Promise<string> {
  const verdict = await screen(text, inputId, 'model-bound');
  if (verdict.decision === 'BLOCK') {
    throw new GatewayBlockedError(
      'This request was blocked by the safety filter.',
      verdict.reasonCodes,
    );
  }
  return verdict.safeText;
}

/* ------------------------------------------------------------------ *
 * Route glue
 * ------------------------------------------------------------------ */

export interface GatewayErrorReply {
  status: number;
  body: { error: string; message: string; reasonCodes: string[] };
}

/**
 * Turn a `GatewayBlockedError` into the response every route should give.
 *
 * Returns null for anything else so callers rethrow rather than swallowing an
 * unrelated failure as a safety refusal.
 *
 * A refused prompt and an unscreenable one are reported differently on purpose:
 * the first is the learner's to fix by rephrasing, the second is ours and they
 * can only wait.
 */
export function gatewayErrorReply(err: unknown): GatewayErrorReply | null {
  if (!(err instanceof GatewayBlockedError)) return null;
  return {
    status: 422,
    body: {
      error: err.unscreened ? 'screening_unavailable' : 'prompt_blocked',
      message: err.unscreened
        ? 'The safety filter is unavailable, so this request cannot be processed right now.'
        : 'This request was blocked by the safety filter. Try rephrasing and send it again.',
      reasonCodes: err.reasonCodes,
    },
  };
}
