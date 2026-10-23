/**
 * Provider construction. The only place adapters are instantiated, and the only
 * place an adapter id is switched on.
 */

import { AnthropicAdapter } from './adapters/anthropic.js';
import { OpenAICompatibleAdapter } from './adapters/openai-compatible.js';
import { getModel, getVendor, resolveModel, resolveProjectStage } from './registry.js';
import type { ProjectStage, ProjectTier, TaskKind } from './registry.js';
import { LLMConfigError } from './types.js';
import type { LLMProvider, ReasoningEffort } from './types.js';

export interface CreateProviderOptions {
  env?: NodeJS.ProcessEnv;
}

export function createProvider(
  modelId: string,
  { env = process.env }: CreateProviderOptions = {},
): LLMProvider {
  const model = getModel(modelId);
  if (!model) {
    throw new LLMConfigError(`Unknown model '${modelId}'. Register it in packages/llm/src/registry.ts.`);
  }

  const vendor = getVendor(modelId);
  if (!vendor) {
    throw new LLMConfigError(`Model '${modelId}' names vendor '${model.vendor}', which is not registered.`);
  }

  const apiKey = env[vendor.envKey];
  if (!apiKey || !apiKey.trim()) {
    throw new LLMConfigError(
      `${vendor.label} is not configured — set ${vendor.envKey} to use '${modelId}'.`,
    );
  }

  switch (vendor.adapter) {
    case 'anthropic':
      return new AnthropicAdapter(model, apiKey);
    case 'openai-compatible':
      return new OpenAICompatibleAdapter(model, vendor, apiKey);
  }
}

/**
 * Provider for a task, honouring the user's pick when it is usable and falling
 * back to the task default. Throws when nothing at all is configured, or, with
 * PROJECT_LEARNER on, when a project task has no Claude key.
 */
export function createProviderForTask(
  task: TaskKind,
  userChoice?: string | undefined,
  { env = process.env }: CreateProviderOptions = {},
): LLMProvider {
  const model = resolveModel(task, userChoice, env);
  if (!model) {
    throw new LLMConfigError(
      'No LLM provider is configured. Set at least one of ANTHROPIC_API_KEY, ' +
        'OPENAI_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, or MOONSHOT_API_KEY.',
    );
  }
  return createProvider(model.id, { env });
}

export interface StageProvider {
  provider: LLMProvider;
  reasoning: ReasoningEffort;
  maxTokens: number;
}

/**
 * Provider plus effort and output ceiling for one project stage, all read from
 * `PROJECT_MODELS`. There is no user choice to pass: project stages are not
 * picked in the UI. Throws `ProjectGenerationUnavailableError` when the flag is
 * on and no Claude key is set.
 */
export function createProviderForStage(
  stage: ProjectStage,
  tier: ProjectTier,
  { env = process.env }: CreateProviderOptions = {},
): StageProvider {
  const { model, reasoning, maxTokens } = resolveProjectStage(stage, tier, env);
  return { provider: createProvider(model.id, { env }), reasoning, maxTokens };
}
