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
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { zodToJsonSchema } from 'zod-to-json-schema';

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
  CacheTtl,
  LLMCitation,
  LLMEvent,
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMSourceDocument,
  LLMStopReason,
  LLMSystemBlock,
  LLMTextSegment,
  LLMUsage,
  OutputSchema,
  ProviderCapabilities,
  ReasoningEffort,
  ServerToolSpec,
  StructuredResult,
  UploadedFile,
} from '../types.js';
import { addUsage } from '../cost.js';

const FILES_BETA = 'files-api-2025-04-14';

/** Streaming can afford a large ceiling; non-streaming must stay under HTTP timeouts. */
const DEFAULT_STREAM_MAX_TOKENS = 64_000;
const DEFAULT_SYNC_MAX_TOKENS = 16_000;

/**
 * How many times a turn paused by a long server-tool loop is sent back. The
 * research budget is 3 searches and 4 fetches, so a few continuations finish
 * it; a turn still paused after that is returned as it stands.
 */
const MAX_PAUSE_CONTINUATIONS = 3;

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

/**
 * `cache_creation` splits writes by TTL, so 5-minute writes can be priced at
 * their own rate; `server_tool_use` counts the web searches billed per search.
 * Both are left out when absent rather than reported as zero.
 */
export function mapAnthropicUsage(usage: Anthropic.Usage | undefined): LLMUsage {
  const fiveMinute = usage?.cache_creation?.ephemeral_5m_input_tokens;
  const searches = usage?.server_tool_use?.web_search_requests;
  const fetches = usage?.server_tool_use?.web_fetch_requests;
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    ...(typeof fiveMinute === 'number' ? { cacheWrite5mTokens: fiveMinute } : {}),
    ...(typeof searches === 'number' && searches > 0 ? { webSearchRequests: searches } : {}),
    ...(typeof fetches === 'number' && fetches > 0 ? { webFetchRequests: fetches } : {}),
  };
}

const mapUsage = mapAnthropicUsage;

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
      ...(req.serverTools?.length ? { tools: buildServerTools(req.serverTools) } : {}),
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
      const params = this.baseParams(req, false) as Anthropic.MessageCreateParamsNonStreaming;
      const options = req.signal ? { signal: req.signal } : undefined;
      let message = await this.client.messages.create(params, options);
      this.assertNotRefusal(message);
      if (!req.serverTools?.length) return this.toResponse(message);

      /*
       * A long server-tool loop can stop with `pause_turn`. The paused turn is
       * sent back unchanged as the assistant's message and the model carries
       * on; the turns together are one answer, so their content and usage add.
       *
       * They also share one output budget: each continuation may write only
       * what the turns before it left of `max_tokens`, so a stage's ceiling
       * in PROJECT_MODELS holds however often the turn pauses (invariant 28).
       */
      const turns: Anthropic.Message[] = [message];
      let messages = params.messages;
      let remaining = params.max_tokens - message.usage.output_tokens;
      for (let i = 0; i < MAX_PAUSE_CONTINUATIONS && message.stop_reason === 'pause_turn' && remaining > 0; i += 1) {
        messages = [...messages, { role: 'assistant', content: message.content as never }];
        message = await this.client.messages.create({ ...params, max_tokens: remaining, messages }, options);
        remaining -= message.usage.output_tokens;
        this.assertNotRefusal(message);
        turns.push(message);
      }
      return this.toToolResponse(turns);
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /* ---------------- structured output ---------------- */

  /**
   * Native schema enforcement. No repair loop is needed here because the API
   * constrains generation server-side. The answer is still validated with the
   * caller's schema: that applies its defaults and transforms, and a truncated
   * response (cut off by max_tokens) surfaces as a real error rather than
   * letting `undefined` leak downstream.
   */
  async structured<Out>(req: LLMRequest, schema: OutputSchema<Out>): Promise<StructuredResult<Out>> {
    const params = this.baseParams(req, false);
    const outputConfig = {
      ...((params as Record<string, unknown>)['output_config'] as Record<string, unknown>),
      format: buildOutputFormat(schema),
    };

    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(
        { ...params, output_config: outputConfig } as never,
        req.signal ? { signal: req.signal } : undefined,
      );
      this.assertNotRefusal(message);
    } catch (err) {
      throw this.mapError(err);
    }

    const raw = extractText(message);
    const fail = (issues: string[]) =>
      new LLMStructuredOutputError(
        'Model returned no valid structured output (likely truncated by max_tokens).',
        { provider: this.id, model: this.modelId, raw, issues },
      );

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw fail([err instanceof Error ? err.message : 'not JSON']);
    }
    const validated = schema.safeParse(json);
    if (!validated.success) {
      throw fail(validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
    }

    return {
      data: validated.data,
      usage: mapUsage(message.usage),
      model: this.entry.providerModel,
      strategy: 'native-schema',
      repaired: false,
    };
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

  /** The joined turns of a server-tool call, with citations and sources as data. */
  private toToolResponse(turns: Anthropic.Message[]): LLMResponse {
    const blocks = turns.flatMap((t) => t.content ?? []);
    const last = turns[turns.length - 1]!;
    const { segments, sources } = extractCitedContent(blocks);
    return {
      text: segments.map((s) => s.text).join(''),
      usage: turns.map((t) => mapUsage(t.usage)).reduce(addUsage),
      stopReason: mapStopReason(last.stop_reason),
      model: last.model ?? this.entry.providerModel,
      segments,
      sources,
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
 * `output_config.format` for a schema.
 *
 * Not the SDK's `zodOutputFormat`: that takes zod v4 schemas only and throws
 * on the v3 schemas this codebase uses, before any request is sent. The JSON
 * schema goes through the SDK's own transform, which drops the keywords
 * structured outputs reject. Its `parse` is removed because `messages.create`
 * would send it as a field; the caller's schema validates the answer instead.
 */
export function buildOutputFormat(schema: OutputSchema<unknown>): Record<string, unknown> {
  const json = zodToJsonSchema(schema as never, { $refStrategy: 'none', target: 'jsonSchema7' });
  const { $schema: _ignored, ...body } = json as Record<string, unknown>;
  const { parse: _parse, ...format } = jsonSchemaOutputFormat(body as never);
  return format;
}

/**
 * The research pass's server tools, as Claude's tool definitions.
 *
 * The 20260318 versions filter results with code before they reach the
 * context, which keeps token use down. The API takes `allowed_domains` or
 * `blocked_domains`, never both, so a spec with both is our bug and fails
 * before anything is sent.
 */
export function buildServerTools(specs: ServerToolSpec[]): Record<string, unknown>[] {
  return specs.map((spec) => {
    if (spec.allowedDomains?.length && spec.blockedDomains?.length) {
      throw new LLMBadRequestError(`${spec.kind} takes allowed or blocked domains, not both.`);
    }
    const domains = spec.allowedDomains?.length
      ? { allowed_domains: spec.allowedDomains }
      : spec.blockedDomains?.length
        ? { blocked_domains: spec.blockedDomains }
        : {};
    if (spec.kind === 'web_search') {
      return { type: 'web_search_20260318', name: 'web_search', max_uses: spec.maxUses, ...domains };
    }
    return {
      type: 'web_fetch_20260318',
      name: 'web_fetch',
      max_uses: spec.maxUses,
      ...domains,
      max_content_tokens: spec.maxContentTokens,
      ...(spec.citations ? { citations: { enabled: true } } : {}),
    };
  });
}

interface FetchedDocument {
  url: string;
  title: string | null;
}

/**
 * Text blocks with their citations, and the pages searched and fetched.
 *
 * A search citation carries its URL. A fetch citation points at a document by
 * index and title, so it is resolved against the fetch results in the order
 * they appear: by title first, then by index.
 */
export function extractCitedContent(blocks: Anthropic.ContentBlock[]): {
  segments: LLMTextSegment[];
  sources: LLMSourceDocument[];
} {
  const sources: LLMSourceDocument[] = [];
  const fetched: FetchedDocument[] = [];

  for (const block of blocks) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const result of block.content) {
        sources.push({ url: result.url, title: result.title ?? null, retrievedAt: null, via: 'search' });
      }
    } else if (block.type === 'web_fetch_tool_result' && block.content.type === 'web_fetch_result') {
      const title = block.content.content?.title ?? null;
      fetched.push({ url: block.content.url, title });
      sources.push({ url: block.content.url, title, retrievedAt: block.content.retrieved_at ?? null, via: 'fetch' });
    }
  }

  const resolveDocument = (index: number, title: string | null): FetchedDocument | undefined =>
    (title ? fetched.find((d) => d.title === title) : undefined) ?? fetched[index];

  const segments: LLMTextSegment[] = [];
  for (const block of blocks) {
    if (block.type !== 'text') continue;
    const citations: LLMCitation[] = [];
    for (const c of block.citations ?? []) {
      if (c.type === 'web_search_result_location') {
        citations.push({ url: c.url, title: c.title ?? null, citedText: c.cited_text });
      } else if (c.type === 'search_result_location') {
        citations.push({ url: c.source, title: c.title ?? null, citedText: c.cited_text });
      } else {
        const doc = resolveDocument(c.document_index, c.document_title ?? null);
        if (doc) citations.push({ url: doc.url, title: c.document_title ?? doc.title, citedText: c.cited_text });
      }
    }
    segments.push({ text: block.text, citations });
  }

  return { segments, sources };
}

/**
 * The cache boundary becomes a `cache_control` marker, with a 1h TTL unless the
 * block asks for `'5m'`.
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
    ...(block.cacheBoundary ? { cache_control: cacheControl(block.cacheTtl ?? '1h') } : {}),
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

/**
 * Omitting `ttl` is the API's 5-minute default; `'1h'` is the only value
 * that has to be spelled out.
 */
function cacheControl(ttl: CacheTtl): Anthropic.CacheControlEphemeral {
  return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
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
          ...(part.cacheBoundary ? { cache_control: cacheControl(part.cacheTtl ?? '5m') } : {}),
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
