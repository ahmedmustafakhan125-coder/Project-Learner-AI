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

  /* --- Everything below needs verification before it can be trusted --- *
   * Base URLs and env keys are safe; model ids and prices are NOT. Check
   * each vendor's docs (VENDORS[x].docsURL), correct the entry, set pricing,
   * then stamp verifiedOn. Until then cost is recorded as null.            */
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
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    vendor: 'gemini',
    providerModel: 'gemini-2.5-flash',
    pricing: null,
    capabilities: OPENAI_COMPATIBLE_CAPS({
      maxContext: 1_048_576,
      maxOutputTokens: 65_536,
    }),
    verifiedOn: null,
    blurb: 'Fast and affordable. Great for everyday tasks.',
  },
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    vendor: 'gemini',
    providerModel: 'gemini-2.5-pro',
    pricing: null,
    capabilities: OPENAI_COMPATIBLE_CAPS({
      maxContext: 1_048_576,
      maxOutputTokens: 65_536,
    }),
    verifiedOn: null,
    blurb: 'Strongest Gemini model. Best for complex reasoning.',
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
  interview: 'claude-haiku-4-5',
  fanout: 'claude-opus-5',
  projectGen: 'claude-opus-5',
  review: 'claude-sonnet-5',
  utility: 'claude-haiku-4-5',
};

/**
 * Resolve the model for a task: the user's pick when it is configured,
 * otherwise the task default, otherwise any configured model at all.
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
