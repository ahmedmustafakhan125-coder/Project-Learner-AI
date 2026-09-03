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

import type { ProviderCapabilities } from './types.js';

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
  /** Writing a cache entry. Omit when caching is automatic and unpriced. */
  cacheWritePerMTok?: number;
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

const BUILTIN_MODELS: ModelEntry[] = [
  /* --- Anthropic: verified against the current Claude API reference --- */
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
    blurb: 'Strongest reasoning. Default for project generation.',
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
    blurb: 'Balanced cost and capability.',
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
    blurb: 'Cheap and fast. Default for the context interview.',
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
  {
    id: 'gemini-3.7-flash',
    label: 'Gemini 3.7 Flash (Default)',
    vendor: 'gemini',
    providerModel: 'gemini-3.6-flash',
    pricing: {
      inputPerMTok: 0.10,
      outputPerMTok: 0.40,
      cacheReadPerMTok: 0.025,
      cacheWritePerMTok: 0.10,
    },
    capabilities: OPENAI_COMPATIBLE_CAPS({
      maxContext: 1_048_576,
      maxOutputTokens: 65_536,
    }),
    verifiedOn: '2026-09-02',
    blurb: 'Fast, intelligent, and multimodal. Default Google Gemini model.',
  },
  {
    id: 'gemini-3.6-flash',
    label: 'Gemini 3.6 Flash',
    vendor: 'gemini',
    providerModel: 'gemini-3.6-flash',
    pricing: {
      inputPerMTok: 0.10,
      outputPerMTok: 0.40,
      cacheReadPerMTok: 0.025,
      cacheWritePerMTok: 0.10,
    },
    capabilities: OPENAI_COMPATIBLE_CAPS({
      maxContext: 1_048_576,
      maxOutputTokens: 65_536,
    }),
    verifiedOn: '2026-09-02',
    blurb: 'Fast and intelligent. Gemini model.',
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini Flash',
    vendor: 'gemini',
    providerModel: 'gemini-3.6-flash',
    pricing: {
      inputPerMTok: 0.10,
      outputPerMTok: 0.40,
      cacheReadPerMTok: 0.025,
      cacheWritePerMTok: 0.10,
    },
    capabilities: OPENAI_COMPATIBLE_CAPS({
      maxContext: 1_048_576,
      maxOutputTokens: 65_536,
    }),
    verifiedOn: '2026-09-02',
    blurb: 'Fast and intelligent. Gemini model.',
  },
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini Pro',
    vendor: 'gemini',
    providerModel: 'gemini-3.6-flash',
    pricing: {
      inputPerMTok: 0.10,
      outputPerMTok: 0.40,
      cacheReadPerMTok: 0.025,
      cacheWritePerMTok: 0.10,
    },
    capabilities: OPENAI_COMPATIBLE_CAPS({
      maxContext: 1_048_576,
      maxOutputTokens: 65_536,
    }),
    verifiedOn: '2026-09-02',
    blurb: 'Fast and intelligent. Gemini model.',
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
  return listModels().filter((m) => isConfigured(m.id, env));
}

/* ------------------------------------------------------------------ *
 * Per-task defaults
 * ------------------------------------------------------------------ */

export type TaskKind = 'interview' | 'fanout' | 'projectGen' | 'review' | 'utility';

/**
 * Which model runs which job when the user has not chosen one. A cheap model
 * handles the interview and incidental calls; the strong one generates
 * projects. Changing the cost profile of the whole app is a one-line edit here.
 */
export const TASK_DEFAULTS: Record<TaskKind, string> = {
  interview: 'gemini-3.7-flash',
  fanout: 'gemini-3.7-flash',
  projectGen: 'gemini-3.7-flash',
  review: 'gemini-3.7-flash',
  utility: 'gemini-3.7-flash',
};

/**
 * Intelligent preference fallback chains across all supported providers.
 * If the operator provides ANY key (Google Gemini, OpenAI, Anthropic, OpenRouter, DeepSeek, Moonshot),
 * the system automatically selects the highest-tier available model for that specific task.
 */
export const TASK_PREFERENCE_CHAINS: Record<TaskKind, string[]> = {
  interview: [
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'claude-haiku-4-5',
    'gpt-4o-mini',
    'openrouter/auto',
    'deepseek-chat',
    'kimi-moonshot-128k',
  ],
  fanout: [
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gpt-4o',
    'claude-opus-5',
    'openrouter/claude-3.5-sonnet',
    'openrouter/gpt-4o',
    'o3-mini',
    'claude-sonnet-5',
    'gpt-4o-mini',
    'openrouter/auto',
    'deepseek-chat',
  ],
  projectGen: [
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gpt-4o',
    'claude-opus-5',
    'openrouter/claude-3.5-sonnet',
    'openrouter/gpt-4o',
    'o1',
    'o3-mini',
    'openrouter/deepseek-r1',
    'claude-sonnet-5',
    'deepseek-reasoner',
  ],
  review: [
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gpt-4o',
    'claude-sonnet-5',
    'openrouter/claude-3.5-sonnet',
    'o3-mini',
    'claude-opus-5',
    'openrouter/auto',
    'deepseek-chat',
  ],
  utility: [
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'claude-haiku-4-5',
    'gpt-4o-mini',
    'openrouter/auto',
    'deepseek-chat',
    'kimi-moonshot-128k',
  ],
};

/**
 * Resolve the model for a task:
 * 1. The user's explicit choice (if configured).
 * 2. The highest-tier model configured in the task's preference chain.
 * 3. The canonical task default.
 * 4. Any configured model found in the environment.
 */
export function resolveModel(
  task: TaskKind,
  userChoice?: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
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
