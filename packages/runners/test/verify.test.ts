import { describe, expect, it } from 'vitest';
import type { CheckpointInput, SubmittedFile } from '../src/types.js';
import { runStaticVerification, verify } from '../src/verify.js';

// ─── Helpers ────────────────────────────────────────────────────────────────────

function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  return (async () => {
    for await (const item of gen) items.push(item);
    return items;
  })();
}

const baseCheckpoint: CheckpointInput = {
  requiredFiles: ['src/index.ts'],
  requiredSymbols: ['export'],
  tests: [{ name: 'basic', code: 'expect(1).toBe(1)', failureMessage: 'math is broken' }],
  runtime: 'none',
};

// ─── Layer 1 ────────────────────────────────────────────────────────────────────

describe('Layer 1 – file existence', () => {
  it('passes when all required files are present', async () => {
    const files: SubmittedFile[] = [{ path: 'src/index.ts', contents: 'export const x = 1;' }];
    const results = await collect(verify(files, baseCheckpoint));
    expect(results[0]!.layer).toBe(1);
    expect(results[0]!.passed).toBe(true);
  });

  it('fails when a required file is missing', async () => {
    const files: SubmittedFile[] = [];
    const results = await collect(verify(files, baseCheckpoint));
    expect(results[0]!.layer).toBe(1);
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.message).toContain('src/index.ts');
  });
});

// ─── Layer 2 ────────────────────────────────────────────────────────────────────

describe('Layer 2 – symbol grep', () => {
  it('passes when all required symbols are found', async () => {
    const files: SubmittedFile[] = [{ path: 'src/index.ts', contents: 'export const x = 1;' }];
    const results = await collect(verify(files, baseCheckpoint));
    const layer2 = results.find((r) => r.layer === 2)!;
    expect(layer2.passed).toBe(true);
  });

  it('fails when a required symbol is missing', async () => {
    const files: SubmittedFile[] = [{ path: 'src/index.ts', contents: 'const x = 1;' }];
    const results = await collect(verify(files, baseCheckpoint));
    const layer2 = results.find((r) => r.layer === 2)!;
    expect(layer2.passed).toBe(false);
    expect(layer2.message).toContain('export');
  });
});

// ─── Layer 3 ────────────────────────────────────────────────────────────────────

describe('Layer 3 – test preparation', () => {
  it('assembles test code correctly and always passes', async () => {
    const files: SubmittedFile[] = [{ path: 'src/index.ts', contents: 'export const x = 1;' }];
    const results = await collect(verify(files, baseCheckpoint));
    const layer3 = results.find((r) => r.layer === 3)!;
    expect(layer3.passed).toBe(true);
    expect(layer3.details).toBeDefined();
    expect(layer3.details![0]).toContain('// Test: basic');
    expect(layer3.details![0]).toContain('expect(1).toBe(1)');
  });
});

// ─── Gating ─────────────────────────────────────────────────────────────────────

describe('layer gating', () => {
  it('Layer 1 failure prevents Layer 2 from running', async () => {
    const files: SubmittedFile[] = [];
    const results = await collect(verify(files, baseCheckpoint));
    expect(results).toHaveLength(1);
    expect(results[0]!.layer).toBe(1);
    expect(results[0]!.passed).toBe(false);
  });

  it('Layer 2 failure prevents Layer 3 from running', async () => {
    const files: SubmittedFile[] = [{ path: 'src/index.ts', contents: 'const x = 1;' }];
    const results = await collect(verify(files, baseCheckpoint));
    expect(results).toHaveLength(2);
    expect(results[1]!.layer).toBe(2);
    expect(results[1]!.passed).toBe(false);
  });
});

// ─── runStaticVerification ──────────────────────────────────────────────────────

describe('runStaticVerification', () => {
  it('returns combined result for layers 1+2 (all pass)', async () => {
    const files: SubmittedFile[] = [{ path: 'src/index.ts', contents: 'export const x = 1;' }];
    const result = await runStaticVerification(files, baseCheckpoint);
    expect(result.passed).toBe(true);
    expect(result.layers).toHaveLength(2);
  });

  it('returns failure when layer 1 fails', async () => {
    const files: SubmittedFile[] = [];
    const result = await runStaticVerification(files, baseCheckpoint);
    expect(result.passed).toBe(false);
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0]!.layer).toBe(1);
  });
});
