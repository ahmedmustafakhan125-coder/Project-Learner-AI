/**
 * OpenAI-compatible adapter.
 *
 * One adapter serves OpenAI, DeepSeek, Moonshot/Kimi, Groq, Together,
 * OpenRouter and local Ollama/vLLM — they all speak the same wire protocol and
 * differ only by `baseURL`, model string, and which optional features they
 * implement. Feature differences are read from `ProviderCapabilities`, never
 * from the vendor id.
 */

import OpenAI from 'openai';
import type { ZodType } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { ModelEntry, Vendor } from '../registry.js';
import {
  LLMAuthError,
  LLMBadRequestError,
  LLMContextLengthError,
  LLMError,
  LLMRateLimitError,
  LLMStructuredOutputError,
  LLMUnavailableError,
} from '../types.js';
import type {
  LLMContentPart,
  LLMEvent,
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStopReason,
  LLMUsage,
  OutputSchema,
  ProviderCapabilities,
  StructuredOutputStrategy,
  StructuredResult,
} from '../types.js';

const DEFAULT_MAX_TOKENS = 8_192;

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function mapStopReason(reason: string | null | undefined): LLMStopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return reason ? 'other' : 'end_turn';
  }
}

/**
 * Normalise usage to the neutral contract, where `inputTokens` is the *uncached
 * remainder* (Anthropic's convention).
 *
 * OpenAI-compatible APIs instead report `prompt_tokens` as the TOTAL including
 * cached tokens, so the cached portion must be subtracted or every cached
 * request is billed twice in our own accounting. DeepSeek reports the same
 * split under different field names.
 */
export function mapUsage(usage: unknown): LLMUsage {
  const u = (usage ?? {}) as Record<string, unknown>;
  const promptTokens = Number(u['prompt_tokens'] ?? 0);
  const completionTokens = Number(u['completion_tokens'] ?? 0);

  const details = (u['prompt_tokens_details'] ?? {}) as Record<string, unknown>;
  const cachedTokens = Number(
    details['cached_tokens'] ?? u['prompt_cache_hit_tokens'] ?? 0,
  );

  const reasoningDetails = (u['completion_tokens_details'] ?? {}) as Record<string, unknown>;
  const reasoningTokens = Number(reasoningDetails['reasoning_tokens'] ?? 0);

  return {
    inputTokens: Math.max(0, promptTokens - cachedTokens),
    outputTokens: completionTokens,
    cacheReadTokens: cachedTokens,
    // These providers cache automatically and do not charge a write premium,
    // so there is no write figure to report.
    cacheWriteTokens: 0,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
  };
}

export class OpenAICompatibleAdapter implements LLMProvider {
  readonly id = 'openai-compatible';
  readonly modelId: string;
  readonly capabilities: ProviderCapabilities;

  private readonly client: OpenAI;
  private readonly entry: ModelEntry;

  /** `client` is injectable so the repair path can be tested without a network. */
  constructor(entry: ModelEntry, vendor: Vendor, apiKey: string, client?: OpenAI) {
    this.entry = entry;
    this.modelId = entry.id;
    this.capabilities = entry.capabilities;
    this.client =
      client ??
      new OpenAI({
        apiKey,
        ...(vendor.baseURL ? { baseURL: vendor.baseURL } : {}),
      });
  }

  /* ---------------- request shaping ---------------- */

  /**
   * System blocks are concatenated into one leading system message.
   * `cacheBoundary` is intentionally ignored: these providers cache long
   * prefixes automatically, so the only lever is keeping the prefix bytes
   * stable — which the caller already guarantees.
   */
  private buildMessages(req: LLMRequest): ChatMessage[] {
    const messages: ChatMessage[] = [];

    if (req.system?.length) {
      messages.push({
        role: 'system',
        content: req.system.map((b) => b.text).join('\n\n'),
      });
    }

    for (const msg of req.messages) {
      if (msg.role === 'system' && !this.capabilities.midConversationSystem) {
        // Degrade to a user turn. This still sits after the shared prefix, so
        // the per-agent instruction does not disturb prefix caching.
        messages.push({ role: 'user', content: toPlainText(msg.content) });
        continue;
      }
      messages.push(toChatMessage(msg));
    }

    return messages;
  }

  private baseParams(req: LLMRequest) {
    return {
      model: this.entry.providerModel,
      messages: this.buildMessages(req),
      max_tokens: req.maxTokens ?? Math.min(DEFAULT_MAX_TOKENS, this.capabilities.maxOutputTokens),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.stopSequences?.length ? { stop: req.stopSequences } : {}),
    };
  }

  /* ---------------- streaming ---------------- */

  async *stream(req: LLMRequest): AsyncIterable<LLMEvent> {
    try {
      const stream = await this.client.chat.completions.create(
        {
          ...this.baseParams(req),
          stream: true,
          stream_options: { include_usage: true },
        },
        req.signal ? { signal: req.signal } : undefined,
      );

      yield { type: 'start', model: this.entry.providerModel };

      let text = '';
      let usage: LLMUsage | undefined;
      let stopReason: LLMStopReason = 'end_turn';

      for await (const chunk of stream) {
        // The usage-bearing chunk arrives last and has an empty choices array.
        if (chunk.usage) usage = mapUsage(chunk.usage);

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) stopReason = mapStopReason(choice.finish_reason);

        const delta = choice.delta as
          | { content?: string | null; reasoning_content?: string | null }
          | undefined;
        if (!delta) continue;

        // DeepSeek-style reasoning models stream their chain separately.
        if (delta.reasoning_content) {
          yield { type: 'reasoning_delta', text: delta.reasoning_content };
        }
        if (delta.content) {
          text += delta.content;
          yield { type: 'text_delta', text: delta.content };
        }
      }

      yield {
        type: 'done',
        response: {
          text,
          usage: usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason,
          model: this.entry.providerModel,
        },
      };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /* ---------------- non-streaming ---------------- */

  async complete(req: LLMRequest): Promise<LLMResponse> {
    try {
      const completion = await this.client.chat.completions.create(
        { ...this.baseParams(req), stream: false },
        req.signal ? { signal: req.signal } : undefined,
      );
      return this.toResponse(completion);
    } catch (err) {
      throw this.mapError(err);
    }
  }

  private toResponse(completion: OpenAI.Chat.Completions.ChatCompletion): LLMResponse {
    const choice = completion.choices[0];
    return {
      text: choice?.message?.content ?? '',
      usage: mapUsage(completion.usage),
      stopReason: mapStopReason(choice?.finish_reason),
      model: completion.model ?? this.entry.providerModel,
    };
  }

  /* ---------------- structured output ---------------- */

  /**
   * Tries the best strategy this provider supports, validates with Zod, and on
   * failure runs exactly one repair attempt that feeds the validation errors
   * back to the model. Callers receive a validated object or a typed error —
   * never raw text.
   */
  async structured<Out>(req: LLMRequest, schema: OutputSchema<Out>): Promise<StructuredResult<Out>> {
    const strategy = this.capabilities.structuredOutput;

    const first = await this.attempt(req, schema, strategy);
    if (first.ok) {
      return {
        data: first.data,
        usage: first.usage,
        model: this.entry.providerModel,
        strategy,
        repaired: false,
      };
    }

    const repairReq: LLMRequest = {
      ...req,
      messages: [
        ...req.messages,
        { role: 'assistant', content: first.raw },
        {
          role: 'user',
          content:
            'That response did not match the required schema. Fix these problems and reply ' +
            'with ONLY the corrected JSON object, no prose and no markdown fences:\n' +
            first.issues.map((i) => `- ${i}`).join('\n'),
        },
      ],
    };

    const second = await this.attempt(repairReq, schema, strategy);
    if (second.ok) {
      return {
        data: second.data,
        usage: second.usage,
        model: this.entry.providerModel,
        strategy,
        repaired: true,
      };
    }

    throw new LLMStructuredOutputError(
      'Model output failed schema validation twice.',
      {
        provider: this.id,
        model: this.modelId,
        raw: second.raw,
        issues: second.issues,
      },
    );
  }

  private async attempt<Out>(
    req: LLMRequest,
    schema: OutputSchema<Out>,
    strategy: StructuredOutputStrategy,
  ): Promise<
    { ok: true; data: Out; usage: LLMUsage } | { ok: false; raw: string; issues: string[]; usage: LLMUsage }
  > {
    const params: Record<string, unknown> = { ...this.baseParams(req), stream: false };
    let raw = '';
    let usage: LLMUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    try {
      switch (strategy) {
        case 'native-schema': {
          params['response_format'] = {
            type: 'json_schema',
            json_schema: { name: 'result', strict: true, schema: toStrictJsonSchema(schema) },
          };
          break;
        }
        case 'tool-call': {
          params['tools'] = [
            {
              type: 'function',
              function: {
                name: 'emit_result',
                description: 'Return the result in the required shape.',
                parameters: toStrictJsonSchema(schema),
              },
            },
          ];
          params['tool_choice'] = { type: 'function', function: { name: 'emit_result' } };
          break;
        }
        case 'json-mode': {
          params['response_format'] = { type: 'json_object' };
          params['messages'] = withJsonInstruction(params['messages'] as ChatMessage[], schema);
          break;
        }
        case 'prompt-only': {
          params['messages'] = withJsonInstruction(params['messages'] as ChatMessage[], schema);
          break;
        }
      }

      const completion = (await this.client.chat.completions.create(
        params as never,
        req.signal ? { signal: req.signal } : undefined,
      )) as OpenAI.Chat.Completions.ChatCompletion;

      usage = mapUsage(completion.usage);
      const message = completion.choices[0]?.message;

      raw =
        strategy === 'tool-call'
          ? (message?.tool_calls?.[0] as { function?: { arguments?: string } } | undefined)
              ?.function?.arguments ?? ''
          : message?.content ?? '';
    } catch (err) {
      throw this.mapError(err);
    }

    const parsedJson = safeParseJson(raw);
    if (!parsedJson.ok) {
      return { ok: false, raw, issues: [parsedJson.error], usage };
    }

    const validated = schema.safeParse(parsedJson.value);
    if (!validated.success) {
      return {
        ok: false,
        raw,
        issues: validated.error.issues.map(
          (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
        ),
        usage,
      };
    }

    return { ok: true, data: validated.data, usage };
  }

  /* ---------------- errors ---------------- */

  private mapError(err: unknown): LLMError {
    if (err instanceof LLMError) return err;
    const ctx = { provider: this.id, model: this.modelId, cause: err };

    if (err instanceof OpenAI.APIError) {
      const status = err.status;
      const message = err.message ?? 'Provider API error.';

      if (status === 401 || status === 403) {
        return new LLMAuthError(`${this.entry.vendor} rejected the API key.`, ctx);
      }
      if (status === 429) {
        const retryAfter = Number(err.headers?.['retry-after']);
        return new LLMRateLimitError(`${this.entry.vendor} rate limit reached.`, {
          ...ctx,
          ...(Number.isFinite(retryAfter) ? { retryAfterMs: retryAfter * 1000 } : {}),
        });
      }
      if (status === 400 && /context|maximum context length|too long/i.test(message)) {
        return new LLMContextLengthError(message, ctx);
      }
      if (status === 400 || status === 404 || status === 422) {
        return new LLMBadRequestError(message, ctx);
      }
      if (status !== undefined && status >= 500) {
        return new LLMUnavailableError(`${this.entry.vendor} is unavailable.`, ctx);
      }
      return new LLMError(message, ctx);
    }

    if (err instanceof OpenAI.APIConnectionError) {
      return new LLMUnavailableError(`Could not reach ${this.entry.vendor}.`, ctx);
    }
    return new LLMError(err instanceof Error ? err.message : String(err), ctx);
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function toChatMessage(msg: LLMMessage): ChatMessage {
  if (msg.role === 'assistant') {
    return { role: 'assistant', content: toPlainText(msg.content) };
  }
  if (msg.role === 'system') {
    return { role: 'system', content: toPlainText(msg.content) };
  }

  if (typeof msg.content === 'string') {
    return { role: 'user', content: msg.content };
  }

  const parts = msg.content
    .map((part): OpenAI.Chat.Completions.ChatCompletionContentPart | null => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      if (part.type === 'image') {
        return {
          type: 'image_url',
          image_url: { url: `data:${part.mediaType};base64,${part.data}` },
        };
      }
      // No portable file-reference form across compatible providers; callers
      // inline extracted text instead (see capabilities.supportsFileUpload).
      return null;
    })
    .filter((p): p is OpenAI.Chat.Completions.ChatCompletionContentPart => p !== null);

  return { role: 'user', content: parts };
}

function toPlainText(content: string | LLMContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<LLMContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n');
}

/**
 * OpenAI strict mode requires `additionalProperties: false` on every object.
 * zod-to-json-schema does not add it, so walk the tree and set it.
 */
function toStrictJsonSchema(schema: ZodType<unknown>): Record<string, unknown> {
  const json = zodToJsonSchema(schema as never, { $refStrategy: 'none' }) as Record<string, unknown>;
  return harden(json) as Record<string, unknown>;
}

function harden(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(harden);
  if (node === null || typeof node !== 'object') return node;

  const obj = { ...(node as Record<string, unknown>) };
  if (obj['type'] === 'object') {
    obj['additionalProperties'] = false;
  }
  for (const [key, value] of Object.entries(obj)) {
    obj[key] = harden(value);
  }
  return obj;
}

/** Appends the target shape for providers that cannot enforce a schema. */
function withJsonInstruction(messages: ChatMessage[], schema: ZodType<unknown>): ChatMessage[] {
  const shape = JSON.stringify(zodToJsonSchema(schema as never, { $refStrategy: 'none' }));
  return [
    ...messages,
    {
      role: 'system',
      content:
        'Reply with ONLY a single JSON object matching this JSON Schema. ' +
        'No prose, no explanation, no markdown fences.\n' +
        shape,
    },
  ];
}

/** Tolerates markdown fences and surrounding prose from weaker providers. */
function safeParseJson(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'Model returned an empty response' };

  const candidates = [trimmed];

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced?.[1]) candidates.push(fenced[1]);

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      // try the next candidate
    }
  }
  return { ok: false, error: 'Response was not valid JSON' };
}
