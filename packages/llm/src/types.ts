/**
 * The neutral LLM contract.
 *
 * Everything above `packages/llm` speaks these types and nothing else. No file
 * outside `src/adapters/` may import a vendor SDK, and no file outside this
 * package may branch on a provider id — behaviour differences are expressed as
 * `ProviderCapabilities` flags and handled by the adapters.
 */

import type { ZodType, ZodTypeDef } from 'zod';

/**
 * A Zod schema constrained only by what it *produces*.
 *
 * `ZodType<T>` defaults its Input parameter to `T` as well, so any schema using
 * `.default()` or `.transform()` — where input and output differ — fails to
 * match and TypeScript falls back to inferring the input type. Callers then get
 * a result whose defaulted fields are typed optional even though they are
 * always present. Leaving Input as `unknown` binds `Out` to the output type,
 * which is what a caller actually receives.
 */
export type OutputSchema<Out> = ZodType<Out, ZodTypeDef, unknown>;

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

export type LLMRole = 'system' | 'user' | 'assistant';

export interface LLMTextPart {
  type: 'text';
  text: string;
  /**
   * Marks the end of the portion of this message shared across sibling
   * requests. In a fan-out the question and its attachments are identical for
   * all four agents, so caching them here means the attachment bytes are
   * processed once rather than four times.
   *
   * Uses the default 5-minute TTL rather than the system prompt's 1 hour: this
   * content only has to survive the few seconds between sibling requests, and
   * the shorter TTL has a cheaper write premium (1.25x vs 2x).
   */
  cacheBoundary?: boolean;
}

export interface LLMImagePart {
  type: 'image';
  /** e.g. `image/png` */
  mediaType: string;
  /** base64, no data: prefix, no newlines */
  data: string;
}

/** A file already uploaded to the provider; see `LLMProvider.uploadFile`. */
export interface LLMFilePart {
  type: 'file';
  fileId: string;
  mediaType: string;
}

export type LLMContentPart = LLMTextPart | LLMImagePart | LLMFilePart;

export interface LLMMessage {
  role: LLMRole;
  content: string | LLMContentPart[];
}

/**
 * A system prompt is an ordered list of blocks rather than one string so a
 * cache boundary can be marked inside it.
 *
 * `cacheBoundary` means: "cache everything from the start of the request up to
 * and including this block". Adapters for providers with automatic prefix
 * caching ignore it — for those the only lever is prefix stability, which the
 * caller guarantees by keeping these blocks byte-identical across requests.
 */
export interface LLMSystemBlock {
  text: string;
  cacheBoundary?: boolean;
}

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

/**
 * How hard the model should think. Providers that cannot vary reasoning depth
 * ignore this; providers with a simple on/off toggle treat `none` as off and
 * everything else as on.
 */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface LLMRequest {
  /** A registry model id (see `registry.ts`), not a vendor model string. */
  model: string;
  system?: LLMSystemBlock[];
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
  reasoning?: ReasoningEffort;
  stopSequences?: string[];
  signal?: AbortSignal;
}

/* ------------------------------------------------------------------ *
 * Responses
 * ------------------------------------------------------------------ */

export type LLMStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'refusal'
  | 'other';

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from cache (cheap). 0 when the provider does not report it. */
  cacheReadTokens: number;
  /** Tokens written to cache (carries a premium). 0 when not reported. */
  cacheWriteTokens: number;
  reasoningTokens?: number;
}

export interface LLMResponse {
  text: string;
  reasoning?: string;
  usage: LLMUsage;
  stopReason: LLMStopReason;
  /** The vendor model string that actually served the request. */
  model: string;
}

/**
 * Stream events. Ordering contract, asserted by the conformance suite:
 *
 *   start → (reasoning_delta | text_delta)* → done
 *
 * `done` is always the final event on a successful stream. Failures throw a
 * subclass of `LLMError` rather than emitting an event, so a `for await` loop
 * surfaces them naturally and one failed agent in a fan-out cannot be mistaken
 * for a completed one.
 */
export type LLMEvent =
  | { type: 'start'; model: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'done'; response: LLMResponse };

/* ------------------------------------------------------------------ *
 * Structured output
 * ------------------------------------------------------------------ */

/**
 * How a provider can be made to emit schema-valid JSON, best first.
 *
 * - `native-schema` — the API enforces a JSON Schema server-side
 * - `tool-call`     — force a single tool call and read its arguments
 * - `json-mode`     — the API guarantees syntactic JSON but not the shape
 * - `prompt-only`   — nothing but instructions; needs the repair path most
 */
export type StructuredOutputStrategy =
  | 'native-schema'
  | 'tool-call'
  | 'json-mode'
  | 'prompt-only';

export interface StructuredResult<T> {
  data: T;
  usage: LLMUsage;
  model: string;
  /** Which strategy actually produced this, for the conformance report. */
  strategy: StructuredOutputStrategy;
  /** True when the first attempt failed validation and the repair retry saved it. */
  repaired: boolean;
}

/* ------------------------------------------------------------------ *
 * Capabilities
 * ------------------------------------------------------------------ */

export interface ProviderCapabilities {
  /**
   * True when cache boundaries are declared explicitly in the request
   * (Anthropic `cache_control`). False means the provider caches long prefixes
   * automatically and `cacheBoundary` is advisory only.
   */
  explicitCaching: boolean;
  structuredOutput: StructuredOutputStrategy;
  /**
   * True when a `system` message may appear mid-conversation. Used to place a
   * per-agent instruction after a cached prefix without invalidating it.
   */
  midConversationSystem: boolean;
  reasoningControl: 'effort' | 'toggle' | 'none';
  maxContext: number;
  maxOutputTokens: number;
  supportsFileUpload: boolean;
  supportsImages: boolean;
}

/* ------------------------------------------------------------------ *
 * Provider
 * ------------------------------------------------------------------ */

export interface UploadedFile {
  fileId: string;
  mediaType: string;
  bytes: number;
}

export interface LLMProvider {
  /** Adapter id: `anthropic` or `openai-compatible`. */
  readonly id: string;
  /** Registry model id this instance is bound to. */
  readonly modelId: string;
  readonly capabilities: ProviderCapabilities;

  stream(req: LLMRequest): AsyncIterable<LLMEvent>;
  complete(req: LLMRequest): Promise<LLMResponse>;
  structured<Out>(req: LLMRequest, schema: OutputSchema<Out>): Promise<StructuredResult<Out>>;

  countTokens?(req: LLMRequest): Promise<number>;
  uploadFile?(bytes: Uint8Array, filename: string, mediaType: string): Promise<UploadedFile>;
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export interface LLMErrorContext {
  provider?: string;
  model?: string;
  cause?: unknown;
}

/** Base for every failure surfaced by this package. */
export class LLMError extends Error {
  readonly provider: string | undefined;
  readonly model: string | undefined;
  /** Whether retrying the identical request could plausibly succeed. */
  readonly retryable: boolean = false;

  constructor(message: string, ctx: LLMErrorContext = {}) {
    super(message, ctx.cause !== undefined ? { cause: ctx.cause } : undefined);
    this.name = new.target.name;
    this.provider = ctx.provider;
    this.model = ctx.model;
  }
}

/** Missing or rejected credentials. Never retryable. */
export class LLMAuthError extends LLMError {}

/** Malformed request — a bug on our side. Never retryable. */
export class LLMBadRequestError extends LLMError {}

/** Prompt exceeds the model's context window. Not retryable without shrinking. */
export class LLMContextLengthError extends LLMError {}

/** Provider declined on policy grounds. Not retryable. */
export class LLMRefusalError extends LLMError {
  readonly category: string | undefined;
  constructor(message: string, ctx: LLMErrorContext & { category?: string } = {}) {
    super(message, ctx);
    this.category = ctx.category;
  }
}

export class LLMRateLimitError extends LLMError {
  override readonly retryable = true;
  readonly retryAfterMs: number | undefined;
  constructor(message: string, ctx: LLMErrorContext & { retryAfterMs?: number } = {}) {
    super(message, ctx);
    this.retryAfterMs = ctx.retryAfterMs;
  }
}

/** 5xx, connection reset, timeout. Retryable. */
export class LLMUnavailableError extends LLMError {
  override readonly retryable = true;
}

/** The model produced output that never validated, even after the repair retry. */
export class LLMStructuredOutputError extends LLMError {
  readonly raw: string;
  readonly issues: string[];
  constructor(
    message: string,
    ctx: LLMErrorContext & { raw: string; issues: string[] },
  ) {
    super(message, ctx);
    this.raw = ctx.raw;
    this.issues = ctx.issues;
  }
}

/** A model id that is not in the registry, or whose API key is not configured. */
export class LLMConfigError extends LLMError {}
