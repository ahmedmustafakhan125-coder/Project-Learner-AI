import { describe, expect, it } from 'vitest';
import {
  getModel,
  getVendor,
  isConfigured,
  listAvailableModels,
  listModels,
  registerModel,
  registryReport,
  resolveModel,
} from '../src/registry.js';
import { createProvider, createProviderForTask } from '../src/factory.js';
import { LLMConfigError } from '../src/types.js';

const ANTHROPIC_ONLY = { ANTHROPIC_API_KEY: 'sk-test' } as NodeJS.ProcessEnv;
const DEEPSEEK_ONLY = { DEEPSEEK_API_KEY: 'sk-test' } as NodeJS.ProcessEnv;
const NOTHING = {} as NodeJS.ProcessEnv;

describe('registry lookup', () => {
  it('resolves a model to its vendor', () => {
    expect(getModel('claude-opus-5')?.providerModel).toBe('claude-opus-5');
    expect(getVendor('claude-opus-5')?.adapter).toBe('anthropic');
    expect(getVendor('deepseek-chat')?.adapter).toBe('openai-compatible');
  });

  it('routes every non-Anthropic vendor through the single compatible adapter', () => {
    const adapters = new Set(listModels().map((m) => getVendor(m.id)!.adapter));
    expect([...adapters].sort()).toEqual(['anthropic', 'openai-compatible']);
  });

  it('gives every OpenAI-compatible vendor a baseURL', () => {
    for (const model of listModels()) {
      const vendor = getVendor(model.id)!;
      if (vendor.adapter === 'openai-compatible') {
        expect(vendor.baseURL, `${vendor.id} needs a baseURL`).toBeTruthy();
      }
    }
  });
});

describe('key-presence gating', () => {
  it('treats a model as configured only when its vendor key is set', () => {
    expect(isConfigured('claude-opus-5', ANTHROPIC_ONLY)).toBe(true);
    expect(isConfigured('deepseek-chat', ANTHROPIC_ONLY)).toBe(false);
    expect(isConfigured('claude-opus-5', NOTHING)).toBe(false);
  });

  it('treats a blank key as absent', () => {
    expect(isConfigured('claude-opus-5', { ANTHROPIC_API_KEY: '   ' })).toBe(false);
  });

  it('only lists models the user could actually pick', () => {
    const available = listAvailableModels(ANTHROPIC_ONLY).map((m) => m.id);
    expect(available).toContain('claude-opus-5');
    expect(available).not.toContain('deepseek-chat');
  });
});

describe('resolveModel', () => {
  it("honours the user's pick when it is configured", () => {
    expect(resolveModel('fanout', 'claude-haiku-4-5', ANTHROPIC_ONLY)?.id).toBe('claude-haiku-4-5');
  });

  it('ignores a pick whose key is missing and uses the task default', () => {
    expect(resolveModel('fanout', 'deepseek-chat', ANTHROPIC_ONLY)?.id).toBe('claude-opus-5');
  });

  it('falls back to any configured model when the task default is unavailable', () => {
    // Task defaults are all Anthropic; with only DeepSeek configured it must
    // still return something usable rather than nothing.
    expect(resolveModel('fanout', undefined, DEEPSEEK_ONLY)?.vendor).toBe('deepseek');
  });

  it('returns undefined when nothing at all is configured', () => {
    expect(resolveModel('fanout', undefined, NOTHING)).toBeUndefined();
  });

  it('routes the interview to a cheaper model than project generation', () => {
    const interview = resolveModel('interview', undefined, ANTHROPIC_ONLY)!;
    const projectGen = resolveModel('projectGen', undefined, ANTHROPIC_ONLY)!;
    expect(interview.pricing!.inputPerMTok).toBeLessThan(projectGen.pricing!.inputPerMTok);
  });
});

describe('registryReport', () => {
  it('flags configured models whose pricing was never verified', () => {
    const report = registryReport(DEEPSEEK_ONLY);
    expect(report.configured).toContain('deepseek-chat');
    expect(report.unverifiedPricing).toContain('deepseek-chat');
  });

  it('does not flag verified Anthropic pricing', () => {
    expect(registryReport(ANTHROPIC_ONLY).unverifiedPricing).toHaveLength(0);
  });

  it('never reports an unconfigured model as unverified — it is simply unusable', () => {
    const report = registryReport(NOTHING);
    expect(report.configured).toHaveLength(0);
    expect(report.unverifiedPricing).toHaveLength(0);
  });
});

describe('pricing integrity', () => {
  it('requires a verifiedOn date wherever pricing numbers are claimed', () => {
    for (const model of listModels()) {
      if (model.pricing !== null) {
        expect(model.verifiedOn, `${model.id} has pricing but no verifiedOn date`).toBeTruthy();
      }
    }
  });

  it('prices output at or above input for every priced model', () => {
    for (const model of listModels()) {
      if (!model.pricing) continue;
      expect(model.pricing.outputPerMTok).toBeGreaterThanOrEqual(model.pricing.inputPerMTok);
    }
  });
});

describe('createProvider', () => {
  it('builds the Anthropic adapter for a Claude model', () => {
    const provider = createProvider('claude-opus-5', { env: ANTHROPIC_ONLY });
    expect(provider.id).toBe('anthropic');
    expect(provider.capabilities.explicitCaching).toBe(true);
  });

  it('builds the compatible adapter for DeepSeek', () => {
    const provider = createProvider('deepseek-chat', { env: DEEPSEEK_ONLY });
    expect(provider.id).toBe('openai-compatible');
    expect(provider.capabilities.explicitCaching).toBe(false);
  });

  it('fails with a clear message when the key is missing', () => {
    expect(() => createProvider('claude-opus-5', { env: NOTHING })).toThrow(LLMConfigError);
    expect(() => createProvider('claude-opus-5', { env: NOTHING })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('fails on an unknown model rather than guessing', () => {
    expect(() => createProvider('gpt-imaginary', { env: ANTHROPIC_ONLY })).toThrow(/Unknown model/);
  });

  it('names the env vars to set when nothing is configured', () => {
    expect(() => createProviderForTask('fanout', undefined, { env: NOTHING })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });
});

describe('registerModel', () => {
  it('accepts a provider the registry has never heard of', () => {
    // Supporting a self-hosted or brand-new vendor must not require a code change.
    registerModel({
      id: 'test-local-llama',
      label: 'Local Llama',
      vendor: 'deepseek', // reuse a registered vendor's transport
      providerModel: 'llama-3',
      pricing: null,
      capabilities: getModel('deepseek-chat')!.capabilities,
      verifiedOn: null,
    });
    expect(getModel('test-local-llama')?.label).toBe('Local Llama');
    expect(createProvider('test-local-llama', { env: DEEPSEEK_ONLY }).id).toBe('openai-compatible');
  });
});
