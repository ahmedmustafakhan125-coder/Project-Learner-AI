import { loadEnv } from './env.js';

/**
 * The LLM security gateway.
 *
 * Every piece of learner-supplied text is screened here before it can reach a
 * model. The gateway itself is a separate Python service (FastAPI) that runs
 * rule-based detection, a semantic classifier, and Presidio PII analysis, then
 * returns a decision.
 *
 * Three things this module is responsible for, none of which belong in a route:
 *
 *   1. **One failure policy.** Screening sits in front of anything that spends
 *      money or reaches a model, so "what if the gateway is down" has to be
 *      answered once, here, rather than per route where it would drift.
 *   2. **A bounded wait.** The gateway is on the hot path ahead of the fan-out's
 *      lead request, so a hung gateway must not become a hung answer.
 *   3. **Never trusting the response shape.** A malformed reply is treated as a
 *      screening failure, not as an ALLOW.
 *
 * It deliberately lives in `apps/api` and not in `packages/core`: core must stay
 * portable to React Native, where neither this dependency nor an HTTP client of
 * this shape belongs. Core sees only already-screened text.
 */

/* ------------------------------------------------------------------ *
 * Contract
 * ------------------------------------------------------------------ */

export type GatewayDecision = 'ALLOW' | 'MASK' | 'BLOCK';

export interface GatewayVerdict {
  decision: GatewayDecision;
  /** Text to actually send onward. For MASK this carries the redactions. */
  safeText: string;
  /** Machine-readable reasons — e.g. jailbreak, system_prompt_extraction, secret. */
  reasonCodes: string[];
  finalRisk: number | null;
  /** True when the gateway could not be consulted at all. */
  unscreened: boolean;
}

/**
 * Where a screening call is happening, which decides what a gateway outage means.
 *
 * `model-bound` covers anything whose next step is an LLM call. Those fail
 * closed: an unscreened prompt must never reach a model, and refusing is
 * recoverable in a way an injected prompt is not.
 *
 * `read` covers everything else. Those fail open so a gateway outage degrades
 * the security layer rather than taking the whole platform offline.
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
 * Client
 * ------------------------------------------------------------------ */

interface AnalyzeResponse {
  decision?: unknown;
  safe_text?: unknown;
  reason_codes?: unknown;
  final_risk?: unknown;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Screen one piece of text.
 *
 * `inputId` is passed through to the gateway's audit log so a decision can be
 * traced back to the request that caused it.
 */
export async function screen(
  text: string,
  inputId: string,
  context: ScreenContext = 'model-bound',
): Promise<GatewayVerdict> {
  const env = loadEnv();
  const url = env.SECURITY_GATEWAY_URL;

  // Empty input cannot carry an injection and is not worth a round trip.
  if (!text.trim()) {
    return { decision: 'ALLOW', safeText: text, reasonCodes: [], finalRisk: null, unscreened: false };
  }

  if (!url) {
    // Unconfigured is treated exactly like unreachable: the deployment decides
    // whether that is survivable, not this function.
    return unavailable(context, 'security gateway is not configured');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.SECURITY_GATEWAY_TIMEOUT_MS);

  let payload: AnalyzeResponse;
  try {
    const response = await fetch(new URL('/analyze', url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: text, input_id: inputId }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return unavailable(context, `security gateway returned ${response.status}`);
    }
    payload = (await response.json()) as AnalyzeResponse;
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError' ? 'timed out' : 'unreachable';
    return unavailable(context, `security gateway ${reason}`);
  } finally {
    clearTimeout(timer);
  }

  const decision = payload.decision;
  if (decision !== 'ALLOW' && decision !== 'MASK' && decision !== 'BLOCK') {
    // An unrecognised verdict is a screening failure. Defaulting to ALLOW here
    // would turn every future gateway change into a silent bypass.
    return unavailable(context, 'security gateway returned an unrecognised decision');
  }

  const reasonCodes = asStringArray(payload.reason_codes);
  const finalRisk = typeof payload.final_risk === 'number' ? payload.final_risk : null;

  if (decision === 'BLOCK') {
    return { decision, safeText: '', reasonCodes, finalRisk, unscreened: false };
  }

  // MASK must come back with the redacted text. If it does not, the original is
  // NOT a safe fallback — that is precisely the text the gateway wanted changed.
  const safeText = typeof payload.safe_text === 'string' ? payload.safe_text : null;
  if (decision === 'MASK' && safeText === null) {
    return unavailable(context, 'security gateway masked a prompt but returned no safe_text');
  }

  return { decision, safeText: safeText ?? text, reasonCodes, finalRisk, unscreened: false };
}

/** One place to decide what an unusable gateway means. */
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
