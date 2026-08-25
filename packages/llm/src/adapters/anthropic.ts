/**
 * Anthropic adapter.
 *
 * Claude deliberately does NOT go through the OpenAI-compatible adapter: doing
 * so would silently lose explicit prompt caching, adaptive thinking, and the
 * 1M context window.
 *
 * API details that are easy to get wrong from memory, all verified against the
 * current Claude API reference:
 *   - `thinking: { type: 'adaptive' }`. `budget_tokens` returns a 400 on Opus 5.
 *   - Depth is `output_config.effort`, not a token budget.
 *   - Structured output is `output_config.format` via `messages.parse()`.
 *     The old top-level `output_format` parameter is deprecated.
 *   - Assistant prefill returns a 400 on current models.
 *   - Thinking is ON by default on Opus 5; disabling it has two documented
 *     failure modes, so we lower effort instead of ever disabling it.
 */

import Anthropic, { toFile } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

import type { ModelEntry } from '../registry.js';
import {
  LLMAuthError,
  LLMBadRequestError,
  LLMContextLengthError,
  LLMError,
  LLMRateLimitError,
  LLMRefusalError,
  LLMStructuredOutputError,
  LLMUnavailableError,
} from '../types.js';
import type {
  LLMEvent,
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStopReason,
  LLMSystemBlock,
  LLMUsage,
  OutputSchema,
  ProviderCapabilities,
  ReasoningEffort,
  StructuredResult,
  UploadedFile,
} from '../types.js';

const FILES_BETA = 'files-api-2025-04-14';

/** Streaming can afford a large ceiling; non-streaming must stay under HTTP timeouts. */
const DEFAULT_STREAM_MAX_TOKENS = 64_000;
const DEFAULT_SYNC_MAX_TOKENS = 16_000;

type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * `none` maps to `low`, not to disabled thinking. With thinking disabled Opus 5
 * can write a tool call into visible text instead of emitting a tool_use block,
 * and can leak thinking tags into the response. Low effort is cheaper anyway.
 */
function mapEffort(effort: ReasoningEffort | undefined): AnthropicEffort {
  switch (effort) {
    case 'none':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'xhigh':
      return 'xhigh';
    case 'max':
      return 'max';
    case 'high':
    default:
      return 'high';
  }
}

function mapStopReason(reason: string | null | undefined): LLMStopReason {
  switch (reason) {
    case 'end_turn':
      return 'end_turn';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

function mapUsage(usage: Anthropic.Usage | undefined): LLMUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
  };
}

export class AnthropicAdapter implements LLMProvider {
  readonly id = 'anthropic';
  readonly modelId: string;
  readonly capabilities: ProviderCapabilities;

  private readonly client: Anthropic;
  private readonly entry: ModelEntry;

  constructor(entry: ModelEntry, apiKey: string) {
    this.entry = entry;
    this.modelId = entry.id;
    this.capabilities = entry.capabilities;
    this.client = new Anthropic({ apiKey });
  }

  /* ---------------- request shaping ---------------- */

  /**
   * The cache boundary is marked on the flagged system block. Anthropic renders
   * `tools → system → messages`, so a marker on the last shared system block
   * caches everything before it too.
   *
   * The 1h TTL is deliberate: a four-agent fan-out is four requests against one
   * prefix, so the 2x write premium is repaid inside a single query
   * (2.0 + 3x0.1 = 2.3 vs 4.0 uncached) and later queries in the session keep
   * reading it.
   */
  private buildSystem(req: LLMRequest): Anthropic.TextBlockParam[] | undefined {
    return buildSystemBlocks(req.system);
  }

  private buildMessages(messages: LLMMessage[]): Anthropic.MessageParam[] {
    return buildAnthropicMessages(messages, this.capabilities.midConversationSystem);
  }

  private baseParams(req: LLMRequest, streaming: boolean) {
    const outputConfig: Record<string, unknown> = {};
    if (this.capabilities.reasoningControl === 'effort') {
      outputConfig['effort'] = mapEffort(req.reasoning);
    }

    return {
      model: this.entry.providerModel,
      max_tokens:
        req.maxTokens ?? (streaming ? DEFAULT_STREAM_MAX_TOKENS : DEFAULT_SYNC_MAX_TOKENS),
      ...(this.buildSystem(req) ? { system: this.buildSystem(req) } : {}),
      messages: this.buildMessages(req.messages),
      ...(req.stopSequences?.length ? { stop_sequences: req.stopSequences } : {}),
      // Adaptive thinking. Display is left at its default (omitted) — we do not
      // surface reasoning to learners, and summarised thinking costs tokens.
      ...(this.capabilities.reasoningControl === 'effort'
        ? { thinking: { type: 'adaptive' as const } }
        : {}),
      ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    };
  }

  /* ---------------- streaming ---------------- */

  async *stream(req: LLMRequest): AsyncIterable<LLMEvent> {
    const params = this.baseParams(req, true);

    try {
      const stream = this.client.messages.stream(
        params as Anthropic.MessageStreamParams,
        req.signal ? { signal: req.signal } : undefined,
      );

      yield { type: 'start', model: this.entry.providerModel };

      for await (const event of stream) {
        if (event.type !== 'content_block_delta') continue;
        if (event.delta.type === 'text_delta') {
          yield { type: 'text_delta', text: event.delta.text };
        } else if (event.delta.type === 'thinking_delta') {
          yield { type: 'reasoning_delta', text: event.delta.thinking };
        }
      }

      const final = await stream.finalMessage();
      this.assertNotRefusal(final);
      yield { type: 'done', response: this.toResponse(final) };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /* ---------------- non-streaming ---------------- */

  async complete(req: LLMRequest): Promise<LLMResponse> {
    try {
      const message = await this.client.messages.create(
        this.baseParams(req, false) as Anthropic.MessageCreateParamsNonStreaming,
        req.signal ? { signal: req.signal } : undefined,
      );
      this.assertNotRefusal(message);
      return this.toResponse(message);
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /* ---------------- structured output ---------------- */

  /**
   * Native schema enforcement. No repair loop is needed here because the API
   * constrains generation server-side; `parsed_output` is only null when the
   * response was truncated, which we surface as a real error rather than
   * letting `undefined` leak downstream.
   */
  async structured<Out>(req: LLMRequest, schema: OutputSchema<Out>): Promise<StructuredResult<Out>> {
    const params = this.baseParams(req, false);
    const outputConfig = {
      ...((params as Record<string, unknown>)['output_config'] as Record<string, unknown>),
      format: zodOutputFormat(schema as never),
    };

    try {
      const response = await this.client.messages.parse(
        { ...params, output_config: outputConfig } as never,
        req.signal ? { signal: req.signal } : undefined,
      );

      this.assertNotRefusal(response as unknown as Anthropic.Message);

      const parsed = (response as { parsed_output?: Out | null }).parsed_output;
      if (parsed === null || parsed === undefined) {
        throw new LLMStructuredOutputError(
          'Model returned no parseable structured output (likely truncated by max_tokens).',
          {
            provider: this.id,
            model: this.modelId,
            raw: extractText(response as unknown as Anthropic.Message),
            issues: ['parsed_output was null'],
          },
        );
      }

      return {
        data: parsed,
        usage: mapUsage((response as unknown as Anthropic.Message).usage),
        model: this.entry.providerModel,
        strategy: 'native-schema',
        repaired: false,
      };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /* ---------------- extras ---------------- */

  async countTokens(req: LLMRequest): Promise<number> {
    try {
      const result = await this.client.messages.countTokens({
        model: this.entry.providerModel,
        messages: this.buildMessages(req.messages),
        ...(this.buildSystem(req) ? { system: this.buildSystem(req) } : {}),
      } as never);
      return result.input_tokens;
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /**
   * Upload once, reference from all four fan-out requests. Sending the same
   * attachment bytes four times is the naive alternative.
   */
  async uploadFile(
    bytes: Uint8Array,
    filename: string,
    mediaType: string,
  ): Promise<UploadedFile> {
    try {
      const uploaded = await this.client.beta.files.upload({
        file: await toFile(Buffer.from(bytes), filename, { type: mediaType }),
        betas: [FILES_BETA],
      });
      return { fileId: uploaded.id, mediaType, bytes: bytes.byteLength };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /* ---------------- helpers ---------------- */

  private toResponse(message: Anthropic.Message): LLMResponse {
    return {
      text: extractText(message),
      usage: mapUsage(message.usage),
      stopReason: mapStopReason(message.stop_reason),
      model: message.model ?? this.entry.providerModel,
    };
  }

  /** A refusal arrives as HTTP 200, so `stop_reason` must be checked explicitly. */
  private assertNotRefusal(message: Anthropic.Message): void {
    if (message.stop_reason !== 'refusal') return;
    const details = (message as { stop_details?: { category?: string; explanation?: string } })
      .stop_details;
    throw new LLMRefusalError(details?.explanation ?? 'The model declined this request.', {
      provider: this.id,
      model: this.modelId,
      ...(details?.category ? { category: details.category } : {}),
    });
  }

  private mapError(err: unknown): LLMError {
    if (err instanceof LLMError) return err;

    const ctx = { provider: this.id, model: this.modelId, cause: err };

    if (err instanceof Anthropic.AuthenticationError) {
      return new LLMAuthError('Anthropic rejected the API key.', ctx);
    }
    if (err instanceof Anthropic.RateLimitError) {
      const retryAfter = Number(err.headers?.get?.('retry-after'));
      return new LLMRateLimitError('Anthropic rate limit reached.', {
        ...ctx,
        ...(Number.isFinite(retryAfter) ? { retryAfterMs: retryAfter * 1000 } : {}),
      });
    }
    if (err instanceof Anthropic.BadRequestError) {
      const message = err.message ?? '';
      if (/context|too many tokens|max_tokens|prompt is too long/i.test(message)) {
        return new LLMContextLengthError(message, ctx);
      }
      return new LLMBadRequestError(message, ctx);
    }
    if (err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
      return new LLMUnavailableError('Anthropic is unavailable.', ctx);
    }
    if (err instanceof Anthropic.APIError) {
      return new LLMError(err.message ?? 'Anthropic API error.', ctx);
    }
    return new LLMError(err instanceof Error ? err.message : String(err), ctx);
  }
}

/* ------------------------------------------------------------------ *
 * Pure request mapping (exported for unit tests)
 * ------------------------------------------------------------------ */

/**
 * The cache boundary becomes a `cache_control` marker with a 1h TTL.
 *
 * Anthropic renders `tools → system → messages`, so a marker on the last shared
 * system block also caches everything before it. The 1h TTL is deliberate: a
 * four-agent fan-out is four requests against one prefix, so the 2x write
 * premium is repaid inside a single query (2.0 + 3×0.1 = 2.3 vs 4.0 uncached)
 * and later queries in the session keep reading it.
 */
export function buildSystemBlocks(
  system: LLMSystemBlock[] | undefined,
): Anthropic.TextBlockParam[] | undefined {
  if (!system?.length) return undefined;
  return system.map((block) => ({
    type: 'text' as const,
    text: block.text,
    ...(block.cacheBoundary
      ? { cache_control: { type: 'ephemeral' as const, ttl: '1h' as const } }
      : {}),
  }));
}

/**
 * A mid-conversation system message keeps a per-request instruction *after* the
 * cached prefix instead of editing the top-level system prompt, which would
 * invalidate the whole conversation cache. Supported on Opus 5 with no beta
 * header; gated by the capability flag because Sonnet 5 and Haiku 4.5 reject it
 * with a 400. When unsupported it degrades to a user turn, which still sits
 * after the prefix and so still preserves the cache.
 */
export function buildAnthropicMessages(
  messages: LLMMessage[],
  midConversationSystem: boolean,
): Anthropic.MessageParam[] {
  const mapped = messages.map((msg) => {
    if (msg.role === 'system') {
      if (!midConversationSystem) {
        return { role: 'user' as const, content: toAnthropicContent(msg.content) };
      }
      return { role: 'system', content: contentToPlainText(msg.content) };
    }
    return { role: msg.role, content: toAnthropicContent(msg.content) };
  });

  // The `system` role is valid on the wire but is not yet in MessageParam.
  return mapped as unknown as Anthropic.MessageParam[];
}

/* ------------------------------------------------------------------ *
 * Content mapping
 * ------------------------------------------------------------------ */

function toAnthropicContent(
  content: string | import('../types.js').LLMContentPart[],
): string | Anthropic.ContentBlockParam[] {
  if (typeof content === 'string') return content;

  return content.map((part): Anthropic.ContentBlockParam => {
    switch (part.type) {
      case 'text':
        return {
          type: 'text',
          text: part.text,
          // Default 5-minute TTL — this only needs to outlive the gap between
          // sibling fan-out requests, and the write premium is lower than 1h.
          ...(part.cacheBoundary ? { cache_control: { type: 'ephemeral' as const } } : {}),
        };
      case 'image':
        return {
          type: 'image',
          source: { type: 'base64', media_type: part.mediaType as never, data: part.data },
        };
      case 'file':
        return {
          type: 'document',
          source: { type: 'file', file_id: part.fileId },
        } as Anthropic.ContentBlockParam;
    }
  });
}

/** Mid-conversation system messages are text-only. */
function contentToPlainText(content: string | import('../types.js').LLMContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is import('../types.js').LLMTextPart => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n');
}

function extractText(message: Anthropic.Message): string {
  return (message.content ?? [])
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}
