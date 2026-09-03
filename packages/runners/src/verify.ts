import type { CheckpointInput, LayerResult, SubmittedFile, VerificationResult } from './types.js';

/**
 * Async generator that yields LayerResult objects.
 * Each layer gates the next: if a layer fails, subsequent layers are not executed.
 */
export async function* verify(
  files: SubmittedFile[],
  checkpoint: CheckpointInput,
): AsyncGenerator<LayerResult> {
  const submittedPaths = new Set(files.map((f) => f.path));

  // ─── Layer 1: File existence ──────────────────────────────────────────────
  const missingFiles = checkpoint.requiredFiles.filter((p) => !submittedPaths.has(p));
  const layer1: LayerResult =
    missingFiles.length === 0
      ? { layer: 1, passed: true, message: 'All required files present.' }
      : {
          layer: 1,
          passed: false,
          message: `Missing required file(s): ${missingFiles.join(', ')}`,
          details: missingFiles,
        };
  yield layer1;
  if (!layer1.passed) return;

  // ─── Layer 2: Symbol grep ─────────────────────────────────────────────────
  const allContents = files.map((f) => f.contents).join('\n');
  const missingSymbols = checkpoint.requiredSymbols.filter((sym) => !allContents.includes(sym));
  const layer2: LayerResult =
    missingSymbols.length === 0
      ? { layer: 2, passed: true, message: 'All required symbols found.' }
      : {
          layer: 2,
          passed: false,
          message: `Missing required symbol(s): ${missingSymbols.join(', ')}`,
          details: missingSymbols,
        };
  yield layer2;
  if (!layer2.passed) return;

  // ─── Layer 3: Test preparation ────────────────────────────────────────────
  const assembled = checkpoint.tests.map(
    (t) => `// Test: ${t.name}\n${t.code}\n// failureMessage: ${t.failureMessage}`,
  );
  const layer3: LayerResult = {
    layer: 3,
    passed: true,
    message: `Prepared ${assembled.length} test(s) for sandbox execution.`,
    details: assembled,
  };
  yield layer3;
}

/**
 * Convenience wrapper: runs Layer 1 + Layer 2 only (no sandbox required).
 * Used by the server for static verification.
 */
export async function runStaticVerification(
  files: SubmittedFile[],
  checkpoint: CheckpointInput,
): Promise<VerificationResult> {
  const layers: LayerResult[] = [];
  for await (const result of verify(files, checkpoint)) {
    layers.push(result);
    // Stop after layer 2 — do not consume layer 3.
    if (result.layer === 2) break;
  }
  return { passed: layers.every((l) => l.passed), layers };
}
