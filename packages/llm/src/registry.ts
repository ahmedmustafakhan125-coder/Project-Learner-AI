/**
 * Model catalogue.
 *
 * Adding a provider is a data edit here plus making the conformance suite pass.
 * No code outside `src/adapters/` should ever need to change.
 *
 * ## On pricing honesty
 *
 * `pricing: null` means "nobody has verified what this costs yet". Cost
 * accounting then records token counts with a null cost rather than inventing a
 * number, and `registryReport()` lists the gaps. Vendor prices and model ids
 * drift constantly; a plausible-looking wrong number in this file would quietly
 * corrupt every budget decision downstream, which is worse than a null.
 *
 * Fill an entry in, then stamp `verifiedOn` with the date you checked the
 * vendor's own pricing page.
 */

import { LLMConfigError, ProjectGenerationUnavailableError } from './types.js';
import type { ProviderCapabilities, ReasoningEffort } from './types.js';

/* ------------------------------------------------------------------ *
 * Vendors
 * ------------------------------------------------------------------ */

export type AdapterId = 'anthropic' | 'openai-compatible';

export interface Vendor {
  id: string;
  label: string;
  adapter: AdapterId;
  /** Omitted for Anthropic (its SDK knows its own endpoint). */
  baseURL?: string;
  envKey: string;
  docsURL: string;
}

/**
 * Base URLs and env-var names are stable, well-published facts, so they ship
 * filled in. DeepSeek, Moonshot/Kimi, Groq, Together, OpenRouter and local
 * Ollama all expose OpenAI-compatible APIs — one adapter serves all of them.
 */
export const VENDORS: Record<string, Vendor> = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    adapter: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    docsURL: 'https://docs.anthropic.com/en/docs/about-claude/models',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    adapter: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    docsURL: 'https://platform.openai.com/docs/pricing',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    adapter: 'openai-compatible',
    baseURL: 'https://api.deepseek.com',
    envKey: 'DEEPSEEK_API_KEY',
    docsURL: 'https://api-docs.deepseek.com/quick_start/pricing',
  },
  moonshot: {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    adapter: 'openai-compatible',
    baseURL: 'https://api.moonshot.cn/v1',
    envKey: 'MOONSHOT_API_KEY',
    docsURL: 'https://platform.moonshot.cn/docs/pricing',
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    adapter: 'openai-compatible',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    envKey: 'GEMINI_API_KEY',
    docsURL: 'https://ai.google.dev/pricing',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    adapter: 'openai-compatible',
    baseURL: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    docsURL: 'https://openrouter.ai/docs',
  },
};

/* ------------------------------------------------------------------ *
 * Pricing
 * ------------------------------------------------------------------ */

/** USD per 1M tokens. */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Reading a cached prefix. Omit when the provider does not price it separately. */
  cacheReadPerMTok?: number;
  /**
   * Writing a cache entry. Omit when caching is automatic and unpriced. For
   * Claude this is the 1-hour rate, the longest TTL the app writes, so a write
   * whose TTL was not reported is never priced below what it cost.
   */
  cacheWritePerMTok?: number;
  /** Writing a 5-minute cache entry, when the vendor prices it separately. */
  cacheWrite5mPerMTok?: number;
}

export interface ModelEntry {
  /** Canonical id used throughout the app. */
  id: string;
  label: string;
  vendor: string;
  /** The model string this vendor's API expects. */
  providerModel: string;
  pricing: ModelPricing | null;
  capabilities: ProviderCapabilities;
  /**
   * Shortest prefix this model will actually cache. Shorter prefixes are
   * silently not cached — no error, just no savings.
   */
  minCacheablePrefixTokens?: number;
  /** ISO date the pricing and model id were checked against vendor docs. */
  verifiedOn: string | null;
  /** Shown in the model picker. */
  blurb?: string;
  /**
   * Set on an old id that now calls the same model as another entry. It keeps
   * resolving, so stored choices still work, but the picker does not list it
   * twice under one name.
   */
  aliasOf?: string;
}

/* ------------------------------------------------------------------ *
 * Capability presets
 * ------------------------------------------------------------------ */

const CLAUDE_CAPS = (maxContext: number, maxOutputTokens: number): ProviderCapabilities => ({
  explicitCaching: true,
  structuredOutput: 'native-schema',
  midConversationSystem: true,
  reasoningControl: 'effort',
  maxContext,
  maxOutputTokens,
  supportsFileUpload: true,
  supportsImages: true,
});

/**
 * Conservative defaults for an unverified OpenAI-compatible endpoint. Anything
 * better than this must be proven by the conformance suite before being
 * claimed here — an over-claimed capability fails at runtime, in production,
 * on one provider only.
 */
const OPENAI_COMPATIBLE_CAPS = (
  overrides: Partial<ProviderCapabilities> = {},
): ProviderCapabilities => ({
  explicitCaching: false,
  structuredOutput: 'json-mode',
  midConversationSystem: false,
  reasoningControl: 'none',
  maxContext: 128_000,
  maxOutputTokens: 8_192,
  supportsFileUpload: false,
  supportsImages: false,
  ...overrides,
});

/* ------------------------------------------------------------------ *
 * Catalogue
 * ------------------------------------------------------------------ */

/** Gemini 3.6 Flash, shared by its aliases. See the Gemini block below. */
const GEMINI_FLASH_PRICING: ModelPricing = {
  inputPerMTok: 0.75,
  outputPerMTok: 3.75,
  cacheReadPerMTok: 0.075,
};

const BUILTIN_MODELS: ModelEntry[] = [
  /*
   * --- Anthropic, current generation ---
   *
   * Prices from the Claude pricing page and minimum prefixes from the prompt
   * caching page, both read 2026-10-23. Cache hits on Opus 5.5 and Sonnet 5.5
   * are 0.05x input. `cacheWritePerMTok` is the 1h rate the system prompts
   * use; `cacheWrite5mPerMTok` the 5-minute rate of the per-project prefix.
   *
   * Mid-conversation system messages are not claimed: nothing verified them
   * on 5.5, and an over-claim is a 400 in production. Unclaimed, the adapter
   * degrades them to a user turn, which keeps the cache intact.
   */
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    vendor: 'anthropic',
    providerModel: 'claude-opus-5-5',
    pricing: {
      inputPerMTok: 4,
      outputPerMTok: 20,
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: 8,
      cacheWrite5mPerMTok: 5,
    },
    capabilities: { ...CLAUDE_CAPS(1_000_000, 128_000), midConversationSystem: false },
    minCacheablePrefixTokens: 512,
    verifiedOn: '2026-10-23',
    blurb: 'Strongest reasoning. Writes project blueprints from T3 up.',
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    vendor: 'anthropic',
    providerModel: 'claude-sonnet-5-5',
    pricing: {
      inputPerMTok: 2,
      outputPerMTok: 10,
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 4,
      cacheWrite5mPerMTok: 2.5,
    },
    capabilities: { ...CLAUDE_CAPS(1_000_000, 128_000), midConversationSystem: false },
    minCacheablePrefixTokens: 512,
    verifiedOn: '2026-10-23',
    blurb: 'Balanced cost and capability. Writes project research, briefs and steps.',
  },
  {
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    vendor: 'anthropic',
    providerModel: 'claude-haiku-5-5',
    /*
     * Haiku 5.5 is priced by prompt length: $0.10 / $0.50 up to 100k prompt
     * tokens, five times that above. The registry holds one price, so it holds
     * the higher one — a budget may overstate a short call, never understate a
     * long one.
     */
    pricing: {
      inputPerMTok: 0.5,
      outputPerMTok: 2.5,
      cacheReadPerMTok: 0.05,
      cacheWritePerMTok: 1,
      cacheWrite5mPerMTok: 0.625,
    },
    capabilities: { ...CLAUDE_CAPS(1_000_000, 128_000), midConversationSystem: false },
    minCacheablePrefixTokens: 512,
    verifiedOn: '2026-10-23',
    blurb: 'Cheap and fast.',
  },

  /*
   * --- Anthropic, legacy ---
   *
   * Kept so `generation_model` values stored on older projects still resolve.
   * No preference chain names them any more.
   */
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    vendor: 'anthropic',
    providerModel: 'claude-opus-5',
    pricing: {
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheReadPerMTok: 0.5, // ~0.1x input
      cacheWritePerMTok: 10, // 2x input at the 1h TTL this app uses
    },
    capabilities: CLAUDE_CAPS(1_000_000, 128_000),
    minCacheablePrefixTokens: 512,
    verifiedOn: '2026-06-24',
    blurb: 'Legacy. Superseded by Claude Opus 5.5.',
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    vendor: 'anthropic',
    providerModel: 'claude-sonnet-5',
    pricing: {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 6,
    },
    // Mid-conversation system messages are NOT supported on Sonnet 5; the
    // fan-out falls back to appending the per-agent instruction differently.
    capabilities: { ...CLAUDE_CAPS(1_000_000, 128_000), midConversationSystem: false },
    minCacheablePrefixTokens: 1024,
    verifiedOn: '2026-06-24',
    blurb: 'Legacy. Superseded by Claude Sonnet 5.5.',
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    vendor: 'anthropic',
    providerModel: 'claude-haiku-4-5',
    pricing: {
      inputPerMTok: 1,
      outputPerMTok: 5,
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 2,
    },
    capabilities: {
      ...CLAUDE_CAPS(200_000, 64_000),
      reasoningControl: 'none', // `effort` errors on Haiku 4.5
      midConversationSystem: false,
    },
    minCacheablePrefixTokens: 4096,
    verifiedOn: '2026-06-24',
    blurb: 'Legacy. Superseded by Claude Haiku 5.5.',
  },

  /* --- OpenAI: verified against the OpenAI pricing & model reference --- */
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    vendor: 'openai',
    providerModel: 'gpt-4o',
    pricing: {
      inputPerMTok: 2.50,
      outputPerMTok: 10.00,
      cacheReadPerMTok: 1.25,
      cacheWritePerMTok: 2.50,
    },
    capabilities: OPENAI_COMPATIBLE_CAPS({
      maxContext: 128_000,
      maxOutputTokens: 16_384,
      structuredOutput: 'native-schema',
      supportsImages: true,
    }),
    verifiedOn: '2026-09-02',
    blurb: 'High-intelligence flagship OpenAI model for reasoning and coding.',
  },
  {
    id: 'gpt-4o-mini',
    label: 'GPT-4o mini',
    vendor: 'openai',
    providerModel: 'gpt-4o-mini',
    pricing: {
      inputPerMTok: 0.15,
      outputPerMTok: 0.60,
      cacheReadPerMTok: 0.075,
      cacheWritePerMTok: 0.15,
    },
    capabilities: OPENAI_COMPATIBLE_CAPS({
      maxContext: 128_000,
      maxOutputTokens: 16_384,
      structuredOutput: 'native-schema',
      supportsImages: true,
    }),
    verifiedOn: '2026-09-02',
    blurb: 'Fast, cost-efficient small model for snappy responses.',
  },
  {
    id: 'o3-mini',
    label: 'o3-mini',
    vendor: 'openai',
    providerModel: 'o3-mini',
    pricing: {
      inputPerMTok: 1.10,
      outputPerMTok: 4.40,
      cacheReadPerMTok: 0.55,
      cacheWritePerMTok: 1.10,
    },
    capabilities: OPENAI_COMPATIBLE_CAPS({
      maxContext: 200_000,
      maxOutputTokens: 100_000,
      reasoningControl: 'effort',
    }),
    verifiedOn: '2026-09-02',
    blurb: 'High-speed reasoning model specialized for coding and STEM.',
  },
  {
    id: 'o1',
    label: 'o1',
    vendor: 'openai',
    providerModel: 'o1',
    pricing: {
      inputPerMTok: 15.00,
      outputPerMTok: 60.00,
      cacheReadPerMTok: 7.50,
      cacheWritePerMTok: 15.00,
    },
    capabilities: OPENAI_COMPATIBLE_CAPS({
      maxContext: 200_000,
      maxOutputTokens: 100_000,
      reasoningControl: 'effort',
    }),
    verifiedOn: '2026-09-02',
    blurb: 'Full deep reasoning model for complex architectural problems.',
  },
  {
    id: 'gpt-4-turbo',
    label: 'GPT-4 Turbo',
    vendor: 'openai',
    providerModel: 'gpt-4-turbo',
    pricing: {
      inputPerMTok: 10.00,
      outputPerMTok: 30.00,
    },
    capabilities: OPENAI_COMPATIBLE_CAPS({
      maxContext: 128_000,
      maxOutputTokens: 4_096,
    }),
    verifiedOn: '2026-09-02',
    blurb: 'Previous generation GPT-4 flagship model.',
  },

  /* --- Other providers --- */
  {
    id: 'deepseek-chat',
    label: 'DeepSeek Chat',
    vendor: 'deepseek',
    providerModel: 'deepseek-chat',
    pricing: null,
    capabilities: OPENAI_COMPATIBLE_CAPS({ maxContext: 64_000 }),
    verifiedOn: null,
  },
  {
    id: 'deepseek-reasoner',
    label: 'DeepSeek Reasoner',
    vendor: 'deepseek',
    providerModel: 'deepseek-reasoner',
    pricing: null,
    capabilities: OPENAI_COMPATIBLE_CAPS({
      maxContext: 64_000,
      reasoningControl: 'toggle',
    }),
    verifiedOn: null,
  },
  {
    id: 'kimi-moonshot-128k',
    label: 'Kimi (Moonshot 128k)',
    vendor: 'moonshot',
    providerModel: 'moonshot-v1-128k',
    pricing: null,
    capabilities: OPENAI_COMPATIBLE_CAPS({ maxContext: 128_000 }),
    verifiedOn: null,
  },
  /*
   * --- Google Gemini ---
   *
   * Prices from the Gemini pricing page, read 2026-10-23. Caching is implicit,
   * so there is no write price. Gemini 3.6 Flash is $0.75 / $3.75 / $0.075
   * through 2026-12-31 and $1.50 / $7.50 / $0.15 from 2027-01-01: bump these
   * then, or the Q&A budget halves its count overnight.
   *
   * The default stays on 3.6 Flash because the pricing page lists no price for
   * 3.7 Flash. The three ids below it used to be labelled 3.7, Flash and Pro
   * while all calling 3.6 Flash; they keep resolving for stored choices, under
   * a label that names what they call, and leave the picker.
   */
  {
    id: 'gemini-3.6-flash',
    label: 'Gemini 3.6 Flash',
    vendor: 'gemini',
    providerModel: 'gemini-3.6-flash',
    pricing: GEMINI_FLASH_PRICING,
    capabilities: OPENAI_COMPATIBLE_CAPS({
      maxContext: 1_048_576,
      maxOutputTokens: 65_536,
    }),
    verifiedOn: '2026-10-23',
    blurb: 'Fast and intelligent. Default for questions and the interview.',
  },
  ...['gemini-3.7-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'].map(
    (id): ModelEntry => ({
      id,
      label: 'Gemini 3.6 Flash',
      vendor: 'gemini',
      providerModel: 'gemini-3.6-flash',
      pricing: GEMINI_FLASH_PRICING,
      capabilities: OPENAI_COMPATIBLE_CAPS({
        maxContext: 1_048_576,
        maxOutputTokens: 65_536,
      }),
      verifiedOn: '2026-10-23',
      aliasOf: 'gemini-3.6-flash',
    }),
  ),
  {
    id: 'gemini-4-argon',
    label: 'Gemini 4 Argon',
    vendor: 'gemini',
    providerModel: 'gemini-4-argon',
    /*
     * $2 / $10 / $0.10 through 2026-11-30, then $4 / $20 / $0.20. The registry
     * holds one price, so it holds the later one: the tutor's budget is never
     * understated. Paid tier only.
     */
    pricing: {
      inputPerMTok: 4,
      outputPerMTok: 20,
      cacheReadPerMTok: 0.2,
    },
    capabilities: OPENAI_COMPATIBLE_CAPS({
      maxContext: 1_048_576,
      maxOutputTokens: 32_768,
      structuredOutput: 'native-schema',
    }),
    verifiedOn: '2026-10-23',
    blurb: 'Strongest Gemini model. Runs the project tutor.',
  },

  /* --- OpenRouter: Universal Multi-Vendor Routing --- */
  {
    id: 'openrouter/auto',
    label: 'OpenRouter (Auto Router)',
    vendor: 'openrouter',
    providerModel: 'openrouter/auto',
    pricing: null,
    capabilities: OPENAI_COMPATIBLE_CAPS({
      maxContext: 128_000,
      maxOutputTokens: 16_384,
    }),
    verifiedOn: '2026-09-02',
    blurb: 'Automatically routes to the best available model on OpenRouter.',
  },
  {
    id: 'openrouter/claude-3.5-sonnet',
    label: 'Claude 3.5 Sonnet (OpenRouter)',
    vendor: 'openrouter',
    providerModel: 'anthropic/claude-3.5-sonnet',
    pricing: {
      inputPerMTok: 3.0,
      outputPerMTok: 15.0,
    },
    capabilities: OPENAI_COMPATIBLE_CAPS({
      maxContext: 200_000,
      maxOutputTokens: 8_192,
      supportsImages: true,
    }),
    verifiedOn: '2026-09-02',
    blurb: 'Anthropic Claude 3.5 Sonnet routed via OpenRouter.',
  },
  {
    id: 'openrouter/gpt-4o',
    label: 'GPT-4o (OpenRouter)',
    vendor: 'openrouter',
    providerModel: 'openai/gpt-4o',
    pricing: {
      inputPerMTok: 2.50,
      outputPerMTok: 10.00,
    },
    capabilities: OPENAI_COMPATIBLE_CAPS({
      maxContext: 128_000,
      maxOutputTokens: 16_384,
      supportsImages: true,
    }),
    verifiedOn: '2026-09-02',
    blurb: 'OpenAI GPT-4o routed via OpenRouter.',
  },
  {
    id: 'openrouter/deepseek-r1',
    label: 'DeepSeek R1 (OpenRouter)',
    vendor: 'openrouter',
    providerModel: 'deepseek/deepseek-r1',
    pricing: {
      inputPerMTok: 0.55,
      outputPerMTok: 2.19,
    },
    capabilities: OPENAI_COMPATIBLE_CAPS({
      maxContext: 64_000,
      maxOutputTokens: 8_000,
      reasoningControl: 'toggle',
    }),
    verifiedOn: '2026-09-02',
    blurb: 'DeepSeek R1 reasoning model routed via OpenRouter.',
  },
];

/* ------------------------------------------------------------------ *
 * Registry access
 * ------------------------------------------------------------------ */

const registry = new Map<string, ModelEntry>(BUILTIN_MODELS.map((m) => [m.id, m]));

/**
 * Add or replace a model at startup — lets an operator support a provider we
 * have never heard of (a self-hosted vLLM, a new vendor) without a code change,
 * as long as it speaks one of the two adapter protocols.
 */
export function registerModel(entry: ModelEntry): void {
  registry.set(entry.id, entry);
}

export function registerVendor(vendor: Vendor): void {
  VENDORS[vendor.id] = vendor;
}

export function getModel(id: string): ModelEntry | undefined {
  return registry.get(id);
}

export function getVendor(modelId: string): Vendor | undefined {
  const model = registry.get(modelId);
  return model ? VENDORS[model.vendor] : undefined;
}

export function listModels(): ModelEntry[] {
  return [...registry.values()];
}

/** A model is usable only when its vendor's API key is present in the env. */
export function isConfigured(modelId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const vendor = getVendor(modelId);
  if (!vendor) return false;
  const key = env[vendor.envKey];
  return typeof key === 'string' && key.trim().length > 0;
}

/** The models a user may actually pick, i.e. those with a configured key. */
export function listAvailableModels(env: NodeJS.ProcessEnv = process.env): ModelEntry[] {
  return listModels().filter((m) => !m.aliasOf && isConfigured(m.id, env));
}

/* ------------------------------------------------------------------ *
 * Per-task defaults
 * ------------------------------------------------------------------ */

/**
 * Gemini asks, Claude builds (docs/project-learner.md §4).
 *
 * `interview`, `fanout`, `review` and `utility` are conversational and follow
 * the user's pick. `tutor` and the four project tasks are fixed by
 * `TASK_POLICY` once PROJECT_LEARNER is on; with it off they resolve exactly as
 * `fanout` and `projectGen` did before.
 */
export type TaskKind =
  | 'interview'
  | 'fanout'
  | 'tutor'
  | 'projectPlan'
  | 'projectStep'
  | 'projectReview'
  | 'projectResearch'
  /** @deprecated Use `projectPlan`. Kept as an alias for one release. */
  | 'projectGen'
  | 'review'
  | 'utility';

/** The Claude-built jobs. Pinned to Anthropic, never picked in the UI. */
export const PROJECT_TASKS = [
  'projectPlan',
  'projectStep',
  'projectReview',
  'projectResearch',
  'projectGen',
] as const satisfies readonly TaskKind[];

/** The conversational chain, Flash first. */
const QUESTION_CHAIN = [
  'gemini-3.6-flash',
  'gpt-4o',
  'claude-opus-5-5',
  'openrouter/claude-3.5-sonnet',
  'openrouter/gpt-4o',
  'o3-mini',
  'claude-sonnet-5-5',
  'gpt-4o-mini',
  'openrouter/auto',
  'deepseek-chat',
];

/** Cheap first: the interview runs on every message. */
const CHEAP_CHAIN = [
  'gemini-3.6-flash',
  'claude-haiku-5-5',
  'gpt-4o-mini',
  'openrouter/auto',
  'deepseek-chat',
  'kimi-moonshot-128k',
];

/** What project generation resolved to before the flag, and still does with it off. */
const LEGACY_PROJECT_CHAIN = [
  'gemini-3.6-flash',
  'gpt-4o',
  'claude-opus-5-5',
  'openrouter/claude-3.5-sonnet',
  'openrouter/gpt-4o',
  'o1',
  'o3-mini',
  'openrouter/deepseek-r1',
  'claude-sonnet-5-5',
  'deepseek-reasoner',
];

/**
 * Which model runs which job when the user has not chosen one. A cheap model
 * handles the interview and incidental calls; the strong one generates
 * projects. Changing the cost profile of the whole app is a one-line edit here.
 * Project stages read their model per tier from `PROJECT_MODELS` instead.
 */
export const TASK_DEFAULTS: Record<TaskKind, string> = {
  interview: 'gemini-3.6-flash',
  fanout: 'gemini-3.6-flash',
  tutor: 'gemini-4-argon',
  projectPlan: 'claude-opus-5-5',
  projectStep: 'claude-sonnet-5-5',
  projectReview: 'claude-sonnet-5-5',
  projectResearch: 'claude-sonnet-5-5',
  projectGen: 'gemini-3.6-flash',
  review: 'gemini-3.6-flash',
  utility: 'gemini-3.6-flash',
};

/**
 * Preference chains: the first configured model wins. Under `TASK_POLICY` a
 * candidate outside the task's vendors is skipped, so the project chains hold
 * only Claude.
 */
export const TASK_PREFERENCE_CHAINS: Record<TaskKind, string[]> = {
  interview: CHEAP_CHAIN,
  fanout: QUESTION_CHAIN,
  tutor: ['gemini-4-argon', 'gemini-3.6-flash'],
  projectPlan: ['claude-opus-5-5', 'claude-sonnet-5-5'],
  projectStep: ['claude-sonnet-5-5'],
  projectReview: ['claude-sonnet-5-5'],
  projectResearch: ['claude-sonnet-5-5'],
  projectGen: LEGACY_PROJECT_CHAIN,
  review: [
    'gemini-3.6-flash',
    'gpt-4o',
    'claude-sonnet-5-5',
    'openrouter/claude-3.5-sonnet',
    'o3-mini',
    'claude-opus-5-5',
    'openrouter/auto',
    'deepseek-chat',
  ],
  utility: CHEAP_CHAIN,
};

/**
 * Who may run a task, and what happens when nobody configured can.
 *
 * - `allowUserChoice` — whether the UI model pick is honoured at all.
 * - `vendors` — the only vendors that may serve it; null means any.
 * - `onMissing` — `fail` throws `ProjectGenerationUnavailableError`; `chain`
 *   falls back to the task's pre-flag chain.
 *
 * Enforced only with PROJECT_LEARNER=on, so turning the flag off restores the
 * old routing exactly.
 */
export interface TaskPolicy {
  allowUserChoice: boolean;
  vendors: string[] | null;
  onMissing: 'fail' | 'chain';
}

const OPEN_POLICY: TaskPolicy = { allowUserChoice: true, vendors: null, onMissing: 'chain' };
const CLAUDE_ONLY: TaskPolicy = { allowUserChoice: false, vendors: ['anthropic'], onMissing: 'fail' };

export const TASK_POLICY: Record<TaskKind, TaskPolicy> = {
  interview: OPEN_POLICY,
  fanout: OPEN_POLICY,
  tutor: { allowUserChoice: false, vendors: ['gemini'], onMissing: 'chain' },
  projectPlan: CLAUDE_ONLY,
  projectStep: CLAUDE_ONLY,
  projectReview: CLAUDE_ONLY,
  projectResearch: CLAUDE_ONLY,
  projectGen: CLAUDE_ONLY,
  review: OPEN_POLICY,
  utility: OPEN_POLICY,
};

/** What each new task resolved as before the flag. */
const LEGACY_TASK: Partial<Record<TaskKind, TaskKind>> = {
  tutor: 'fanout',
  projectPlan: 'projectGen',
  projectStep: 'projectGen',
  projectReview: 'projectGen',
  projectResearch: 'projectGen',
};

export function projectLearnerOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['PROJECT_LEARNER'] === 'on';
}

/** `PROJECT_GEN_FALLBACK=chain`, which production never honours. */
function devFallbackAllowed(env: NodeJS.ProcessEnv): boolean {
  return env['PROJECT_GEN_FALLBACK'] === 'chain' && env['NODE_ENV'] !== 'production';
}

/**
 * Resolve the model for a task.
 *
 * With PROJECT_LEARNER off, every task resolves as it always has:
 * 1. The user's explicit choice (if configured).
 * 2. The highest-tier model configured in the task's preference chain.
 * 3. The canonical task default.
 * 4. Any configured model found in the environment.
 *
 * With it on, `TASK_POLICY` comes first: a pick it does not allow is ignored
 * and logged, never silently used, and a chain candidate from another vendor
 * is skipped. A project task with no Claude configured throws
 * `ProjectGenerationUnavailableError` (invariant 15) unless
 * PROJECT_GEN_FALLBACK=chain in development, which takes the old chain.
 */
export function resolveModel(
  task: TaskKind,
  userChoice?: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ModelEntry | undefined {
  if (!projectLearnerOn(env)) {
    return resolveOpen(LEGACY_TASK[task] ?? task, userChoice, env);
  }

  const policy = TASK_POLICY[task];
  if (policy.allowUserChoice && policy.vendors === null) {
    return resolveOpen(task, userChoice, env);
  }

  const allowed = (model: ModelEntry | undefined): model is ModelEntry =>
    model !== undefined && (policy.vendors === null || policy.vendors.includes(model.vendor));

  if (userChoice) {
    const picked = getModel(userChoice);
    if (policy.allowUserChoice && allowed(picked) && isConfigured(userChoice, env)) return picked;
    console.warn(`[llm] ignoring model choice '${userChoice}' for ${task}: fixed by TASK_POLICY`);
  }

  for (const candidate of TASK_PREFERENCE_CHAINS[task]) {
    const model = getModel(candidate);
    if (allowed(model) && isConfigured(candidate, env)) return model;
  }

  const legacyTask = LEGACY_TASK[task] ?? task;
  if (policy.onMissing === 'chain') return resolveOpen(legacyTask, undefined, env);
  if (devFallbackAllowed(env)) {
    console.warn(`[llm] no Claude key: ${task} falls back to the ${legacyTask} chain (development)`);
    return resolveOpen(legacyTask, undefined, env);
  }
  throw new ProjectGenerationUnavailableError(task);
}

function resolveOpen(
  task: TaskKind,
  userChoice: string | undefined,
  env: NodeJS.ProcessEnv,
): ModelEntry | undefined {
  if (userChoice && isConfigured(userChoice, env)) {
    const picked = getModel(userChoice);
    if (picked) return picked;
  }
  const chain = TASK_PREFERENCE_CHAINS[task] ?? [];
  for (const candidate of chain) {
    if (isConfigured(candidate, env)) {
      return getModel(candidate);
    }
  }
  const fallback = TASK_DEFAULTS[task];
  if (isConfigured(fallback, env)) return getModel(fallback);
  return listAvailableModels(env)[0];
}

/* ------------------------------------------------------------------ *
 * Project stages
 * ------------------------------------------------------------------ */

/** Complexity tiers, T1 (a one-file script) to T5 (a kernel). See §5. */
export const PROJECT_TIERS = ['T1', 'T2', 'T3', 'T4', 'T5'] as const;
export type ProjectTier = (typeof PROJECT_TIERS)[number];

/**
 * The tier a project route assumes before intake scores one. T3 is the size
 * the old single blueprint call was pitched at.
 */
export const DEFAULT_PROJECT_TIER: ProjectTier = 'T3';

export type ProjectStage = 'research' | 'brief' | 'blueprint' | 'step' | 'finish';

export interface ProjectStageSettings {
  task: TaskKind;
  model: string;
  reasoning: ReasoningEffort;
  maxTokens: number;
}

const stage = (
  task: TaskKind,
  model: string,
  reasoning: ReasoningEffort,
  maxTokens: number,
): ProjectStageSettings => ({ task, model, reasoning, maxTokens });

/**
 * Model, effort and output ceiling for every project stage and tier (§11).
 *
 * The cost of creating a project is set here and nowhere else: routes read
 * this table, and the invariant 28 ceiling test multiplies it out. Opus writes
 * the blueprint from T3 up and nothing else; thinking bills as output, so
 * effort stays as low as each stage allows. `null` means the stage does not
 * run at that tier — T1 never researches.
 */
export const PROJECT_MODELS: Record<ProjectStage, Record<ProjectTier, ProjectStageSettings | null>> = {
  research: {
    T1: null,
    T2: stage('projectResearch', 'claude-sonnet-5-5', 'low', 4_000),
    T3: stage('projectResearch', 'claude-sonnet-5-5', 'low', 4_000),
    T4: stage('projectResearch', 'claude-sonnet-5-5', 'low', 4_000),
    T5: stage('projectResearch', 'claude-sonnet-5-5', 'low', 4_000),
  },
  brief: {
    T1: stage('projectPlan', 'claude-sonnet-5-5', 'low', 4_000),
    T2: stage('projectPlan', 'claude-sonnet-5-5', 'low', 4_000),
    T3: stage('projectPlan', 'claude-sonnet-5-5', 'medium', 8_000),
    T4: stage('projectPlan', 'claude-sonnet-5-5', 'medium', 8_000),
    T5: stage('projectPlan', 'claude-sonnet-5-5', 'medium', 8_000),
  },
  blueprint: {
    T1: stage('projectPlan', 'claude-sonnet-5-5', 'medium', 8_000),
    T2: stage('projectPlan', 'claude-sonnet-5-5', 'medium', 8_000),
    T3: stage('projectPlan', 'claude-opus-5-5', 'medium', 12_000),
    T4: stage('projectPlan', 'claude-opus-5-5', 'high', 12_000),
    T5: stage('projectPlan', 'claude-opus-5-5', 'high', 12_000),
  },
  step: {
    T1: stage('projectStep', 'claude-sonnet-5-5', 'low', 8_000),
    T2: stage('projectStep', 'claude-sonnet-5-5', 'low', 8_000),
    T3: stage('projectStep', 'claude-sonnet-5-5', 'medium', 16_000),
    T4: stage('projectStep', 'claude-sonnet-5-5', 'medium', 16_000),
    T5: stage('projectStep', 'claude-sonnet-5-5', 'medium', 16_000),
  },
  finish: {
    T1: stage('projectStep', 'claude-sonnet-5-5', 'low', 6_000),
    T2: stage('projectStep', 'claude-sonnet-5-5', 'low', 6_000),
    T3: stage('projectStep', 'claude-sonnet-5-5', 'low', 6_000),
    T4: stage('projectStep', 'claude-sonnet-5-5', 'low', 6_000),
    T5: stage('projectStep', 'claude-sonnet-5-5', 'low', 6_000),
  },
};

export interface ResolvedProjectStage {
  model: ModelEntry;
  reasoning: ReasoningEffort;
  maxTokens: number;
}

/**
 * The model and settings for one stage at one tier.
 *
 * The table's model when it is configured; otherwise whatever `resolveModel`
 * allows for the stage's task, which with the flag on means another Claude
 * entry, the development fallback, or `ProjectGenerationUnavailableError`.
 * Effort and `maxTokens` come from the table either way.
 */
export function resolveProjectStage(
  projectStage: ProjectStage,
  tier: ProjectTier,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProjectStage {
  const settings = PROJECT_MODELS[projectStage][tier];
  if (!settings) {
    throw new LLMConfigError(`The ${projectStage} stage does not run for ${tier} projects.`);
  }
  const model = isConfigured(settings.model, env)
    ? getModel(settings.model)
    : resolveModel(settings.task, undefined, env);
  if (!model) {
    throw new LLMConfigError('No LLM provider is configured for project generation.');
  }
  return { model, reasoning: settings.reasoning, maxTokens: settings.maxTokens };
}

/* ------------------------------------------------------------------ *
 * Health report
 * ------------------------------------------------------------------ */

export interface RegistryReport {
  configured: string[];
  unconfigured: string[];
  /** Configured models whose pricing has never been verified — cost will be null. */
  unverifiedPricing: string[];
}

/**
 * Called at API startup. Surfacing unverified pricing loudly is the point:
 * budget enforcement silently degrades to "unmetered" for these models.
 */
export function registryReport(env: NodeJS.ProcessEnv = process.env): RegistryReport {
  const configured: string[] = [];
  const unconfigured: string[] = [];
  const unverifiedPricing: string[] = [];

  for (const model of listModels()) {
    if (isConfigured(model.id, env)) {
      configured.push(model.id);
      if (model.pricing === null || model.verifiedOn === null) {
        unverifiedPricing.push(model.id);
      }
    } else {
      unconfigured.push(model.id);
    }
  }

  return { configured, unconfigured, unverifiedPricing };
}
