'use client';

import { useState, useCallback, useRef } from 'react';
import { verify } from '@ai-edu/runners';
import type { LayerResult } from '@ai-edu/runners';
import { SandboxFrame } from './SandboxFrame';
import { api } from '@/lib/api';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface CheckpointRunnerProps {
  projectId: string;
  stepIndex: number;
  checkpoint: {
    requiredFiles: string[];
    requiredSymbols: string[];
    tests: Array<{ name: string; code: string; failureMessage: string }>;
    runtime: 'web' | 'python' | 'none';
  };
  files: Array<{ path: string; contents: string }>;
  onPass: (solutionFiles?: Array<{ path: string; contents: string }>) => void;
}

type Status = 'idle' | 'running' | 'passed' | 'failed';

interface LayerState {
  status: 'pending' | 'running' | 'passed' | 'failed';
  message: string | null;
}

const INITIAL_LAYERS: [LayerState, LayerState, LayerState] = [
  { status: 'pending', message: null },
  { status: 'pending', message: null },
  { status: 'pending', message: null },
];

/* ------------------------------------------------------------------ */
/* Layer labels                                                        */
/* ------------------------------------------------------------------ */

const LAYER_LABELS = ['Checking files…', 'Checking symbols…', 'Running tests…'] as const;
const PASS_LABELS = ['Files found', 'Symbols found', 'Tests passed'] as const;

/* ------------------------------------------------------------------ */
/* Status icons                                                        */
/* ------------------------------------------------------------------ */

function StatusDot({ status }: { status: LayerState['status'] }) {
  const base: React.CSSProperties = {
    display: 'inline-block',
    width: 10,
    height: 10,
    borderRadius: '50%',
    marginRight: 8,
    flexShrink: 0,
  };

  switch (status) {
    case 'pending':
      return <span style={{ ...base, backgroundColor: '#999' }} />;
    case 'running':
      return (
        <span
          style={{
            ...base,
            backgroundColor: '#d4a017',
            animation: 'cr-pulse 0.8s ease-in-out infinite',
          }}
        />
      );
    case 'passed':
      return (
        <span
          style={{
            ...base,
            backgroundColor: 'transparent',
            color: '#2e7d32',
            fontSize: 14,
            lineHeight: '10px',
            width: 'auto',
            height: 'auto',
            borderRadius: 0,
          }}
          aria-label="passed"
        >
          ✓
        </span>
      );
    case 'failed':
      return (
        <span
          style={{
            ...base,
            backgroundColor: 'transparent',
            color: '#d32f2f',
            fontSize: 14,
            lineHeight: '10px',
            width: 'auto',
            height: 'auto',
            borderRadius: 0,
          }}
          aria-label="failed"
        >
          ✗
        </span>
      );
  }
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function CheckpointRunner({
  projectId,
  stepIndex,
  checkpoint,
  files,
  onPass,
}: CheckpointRunnerProps) {
  const [status, setStatus] = useState<Status>('idle');
  const [layers, setLayers] = useState<[LayerState, LayerState, LayerState]>([
    ...INITIAL_LAYERS,
  ]);
  const [attempts, setAttempts] = useState(0);
  const [sandboxTrigger, setSandboxTrigger] = useState(0);
  const [showSandbox, setShowSandbox] = useState(false);
  const [sandboxProgress, setSandboxProgress] = useState<string | null>(null);
  const startedAtRef = useRef<number>(0);

  /* helpers ---- */

  const updateLayer = useCallback(
    (index: number, patch: Partial<LayerState>) => {
      setLayers((prev) => {
        const next = [...prev] as [LayerState, LayerState, LayerState];
        next[index] = { ...next[index], ...patch };
        return next;
      });
    },
    [],
  );

  /* ---- record attempt via API (stable, reads refs/latest via params) ---- */

  const recordAttempt = useCallback(
    async (allPassed: boolean, durationMs: number) => {
      try {
        const result = await api.submitAttempt(
          projectId,
          stepIndex,
          files,
          durationMs,
        );
        if (allPassed && result.passed) {
          setStatus('passed');
          onPass(result.solutionFiles);
        } else {
          setStatus('failed');
        }
      } catch {
        // The server is the authority on whether a checkpoint passed: it re-runs
        // the static layers and owns the attempt record. If that call fails we
        // do not know the outcome, so the checkpoint does NOT advance — passing
        // a learner on a 500, a 429, or a dropped connection would let them skip
        // steps by going offline.
        setStatus('failed');
        updateLayer(2, {
          status: 'failed',
          message: 'Could not reach the server to record this attempt. Try again.',
        });
      }
    },
    [projectId, stepIndex, files, onPass, updateLayer],
  );

  /* ---- sandbox callbacks ---- */

  const handleSandboxResult = useCallback(
    (result: {
      passed: boolean;
      results: Array<{ name: string; passed: boolean; message: string }>;
    }) => {
      const durationMs = Date.now() - startedAtRef.current;
      if (result.passed) {
        updateLayer(2, { status: 'passed', message: PASS_LABELS[2] });
        recordAttempt(true, durationMs);
      } else {
        const failedTests = result.results.filter((r) => !r.passed);
        const msg = failedTests.map((t) => t.message).join('; ');
        updateLayer(2, { status: 'failed', message: msg });
        recordAttempt(false, durationMs);
      }
    },
    [updateLayer, recordAttempt],
  );

  const handleSandboxError = useCallback(
    (message: string) => {
      const durationMs = Date.now() - startedAtRef.current;
      updateLayer(2, { status: 'failed', message });
      recordAttempt(false, durationMs);
    },
    [updateLayer, recordAttempt],
  );

  const handleSandboxProgress = useCallback(
    (message: string) => setSandboxProgress(message),
    [],
  );

  /* ---- run pipeline ---- */

  const run = useCallback(async () => {
    startedAtRef.current = Date.now();
    setStatus('running');
    setLayers([...INITIAL_LAYERS]);
    setSandboxProgress(null);
    setAttempts((a) => a + 1);
    // Deliberately NOT reset to 0 here. React batches this with the increment
    // below, so resetting first left the trigger on its previous value and the
    // sandbox effect never re-fired — the second run hung on "Running tests".
    // The trigger is monotonic; only ever increment it.

    try {
      /* Layer 1 + 2 via verify generator */
      const gen = verify(files, checkpoint);

      // Layer 1 — file existence
      updateLayer(0, { status: 'running', message: null });
      const layer1Result = await gen.next();
      if (layer1Result.done) return;
      const layer1: LayerResult = layer1Result.value;
      updateLayer(0, {
        status: layer1.passed ? 'passed' : 'failed',
        message: layer1.message,
      });
      if (!layer1.passed) {
        setStatus('failed');
        return;
      }

      // Layer 2 — symbol grep
      updateLayer(1, { status: 'running', message: null });
      const layer2Result = await gen.next();
      if (layer2Result.done) return;
      const layer2: LayerResult = layer2Result.value;
      updateLayer(1, {
        status: layer2.passed ? 'passed' : 'failed',
        message: layer2.message,
      });
      if (!layer2.passed) {
        setStatus('failed');
        return;
      }

      /* Layer 3 — sandbox or skip */
      const needsSandbox =
        checkpoint.runtime !== 'none' && checkpoint.tests.length > 0;

      if (!needsSandbox) {
        updateLayer(2, { status: 'passed', message: 'No tests — auto-passed.' });
        const durationMs = Date.now() - startedAtRef.current;
        await recordAttempt(true, durationMs);
        return;
      }

      // Hand off to sandbox — result arrives via handleSandboxResult / handleSandboxError
      updateLayer(2, { status: 'running', message: null });
      setShowSandbox(true);
      setSandboxTrigger((t) => t + 1);
    } catch (err) {
      setStatus('failed');
      const msg =
        err instanceof Error ? err.message : 'Unexpected error during verification.';
      setLayers((prev) => {
        const next = [...prev] as [LayerState, LayerState, LayerState];
        const idx = next.findIndex(
          (l) => l.status === 'running' || l.status === 'pending',
        );
        if (idx >= 0) next[idx] = { status: 'failed', message: msg };
        return next;
      });
    }
  }, [files, checkpoint, updateLayer, recordAttempt]);

  /* ---- combined code for sandbox ---- */

  const combinedCode = files.map((f) => f.contents).join('\n');

  /* ---- render ---- */

  return (
    <div style={{ fontFamily: 'inherit' }}>
      <style>{`
        @keyframes cr-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>

      {/* Layer results */}
      {status !== 'idle' && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }}>
          {layers.map((layer, i) => (
            <li
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '4px 0',
                fontSize: 14,
                color:
                  layer.status === 'failed'
                    ? '#d32f2f'
                    : layer.status === 'passed'
                      ? '#2e7d32'
                      : '#666',
              }}
            >
              <StatusDot status={layer.status} />
              <span>
                {layer.status === 'running'
                  ? LAYER_LABELS[i]
                  : layer.status === 'passed'
                    ? PASS_LABELS[i]
                    : layer.status === 'failed'
                      ? layer.message ?? 'Failed'
                      : LAYER_LABELS[i]}
              </span>
            </li>
          ))}
          {sandboxProgress && layers[2].status === 'running' && (
            <li style={{ padding: '2px 0 0 18px', fontSize: 12, color: '#888' }}>
              {sandboxProgress}
            </li>
          )}
        </ul>
      )}

      {/* Action area */}
      {status === 'idle' && (
        <button type="button" onClick={run}>
          Run Checkpoint
        </button>
      )}

      {status === 'running' && (
        <button type="button" disabled>
          Verifying…
        </button>
      )}

      {status === 'passed' && (
        <span style={{ color: '#2e7d32', fontWeight: 600, fontSize: 14 }}>
          Checkpoint passed!
        </span>
      )}

      {status === 'failed' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button type="button" onClick={run}>
            Retry
          </button>
          {attempts > 0 && (
            <span style={{ fontSize: 12, color: '#999' }}>Attempt {attempts}</span>
          )}
        </div>
      )}

      {/* Sandbox — invisible iframe, only mounted when needed */}
      {showSandbox && checkpoint.runtime !== 'none' && (
        <SandboxFrame
          runtime={checkpoint.runtime}
          code={combinedCode}
          tests={checkpoint.tests}
          onProgress={handleSandboxProgress}
          onResult={handleSandboxResult}
          onError={handleSandboxError}
          trigger={sandboxTrigger}
        />
      )}
    </div>
  );
}
