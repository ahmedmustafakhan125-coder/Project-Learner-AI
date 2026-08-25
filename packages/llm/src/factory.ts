/**
 * Provider construction. The only place adapters are instantiated, and the only
 * place an adapter id is switched on.
 */

import { AnthropicAdapter } from './adapters/anthropic.js';
import { OpenAICompatibleAdapter } from './adapters/openai-compatible.js';
import { getModel, getVendor, resolveModel } from './registry.js';
import type { TaskKind } from './registry.js';
import { LLMConfigError } from './types.js';
import type { LLMProvider } from './types.js';

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
 * back to the task default. Throws only when nothing at all is configured.
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
        'OPENAI_API_KEY, DEEPSEEK_API_KEY, or MOONSHOT_API_KEY.',
    );
  }
  return createProvider(model.id, { env });
}
