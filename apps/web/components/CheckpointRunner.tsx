'use client';

import { useState, useCallback, useRef } from 'react';
import { verify } from '@ai-edu/runners';
import type { LayerResult } from '@ai-edu/runners';
import type { CheckpointRun } from '@ai-edu/api-client';
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
  /**
   * Attempts made on this step, owned by the parent because the hint gate is
   * driven by the same number. Displayed here; counted there.
   */
  attemptCount: number;
  /** Fired once per checkpoint run, pass or fail. */
  onAttempt: () => void;
  onPass: (solutionFiles?: Array<{ path: string; contents: string }>) => void;
  /** The last run on this step, from a previous visit. Restored into the panel. */
  initialRun?: CheckpointRun | null;
  /** Fired when a run reaches a verdict, so it can outlive the page. */
  onRunComplete?: (run: CheckpointRun) => void;
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

/**
 * Rebuilds the three layer rows from a stored run.
 *
 * Anything mid-flight in the stored record is treated as pending: a run that
 * was interrupted by a closed tab never reached a verdict, and showing it as
 * still "running" would be a spinner that never resolves.
 */
function restoreLayers(run: CheckpointRun | null | undefined): [LayerState, LayerState, LayerState] {
  const restored = [...INITIAL_LAYERS] as [LayerState, LayerState, LayerState];
  if (!run) return restored;

  run.layers.slice(0, 3).forEach((layer, i) => {
    restored[i] = {
      status: layer.status === 'running' ? 'pending' : layer.status,
      message: layer.message,
    };
  });
  return restored;
}

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
      return <span style={{ ...base, backgroundColor: 'var(--text-faint)' }} />;
    case 'running':
      return (
        <span
          style={{
            ...base,
            backgroundColor: 'var(--warn)',
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
            color: 'var(--success)',
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
            color: 'var(--danger)',
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
  attemptCount,
  onAttempt,
  onPass,
  initialRun,
  onRunComplete,
}: CheckpointRunnerProps) {
  // Seeded from the last run, so a step the learner already worked on reopens
  // showing what happened rather than an untouched "Run Checkpoint".
  const [status, setStatus] = useState<Status>(initialRun?.status ?? 'idle');
  const [layers, setLayers] = useState<[LayerState, LayerState, LayerState]>(
    () => restoreLayers(initialRun),
  );
  const [sandboxTrigger, setSandboxTrigger] = useState(0);
  const [showSandbox, setShowSandbox] = useState(false);
  const [sandboxProgress, setSandboxProgress] = useState<string | null>(null);
  const startedAtRef = useRef<number>(0);

  /* helpers ---- */

  // The layers are also tracked in a ref. A verdict has to be reported together
  // with the rows the learner is looking at, and reading them out of state at
  // that moment would give the values from before the last update.
  const layersRef = useRef<[LayerState, LayerState, LayerState]>(restoreLayers(initialRun));

  const updateLayer = useCallback((index: number, patch: Partial<LayerState>) => {
    const next = [...layersRef.current] as [LayerState, LayerState, LayerState];
    next[index] = { ...next[index], ...patch };
    layersRef.current = next;
    setLayers(next);
  }, []);

  const resetLayers = useCallback(() => {
    layersRef.current = [...INITIAL_LAYERS] as [LayerState, LayerState, LayerState];
    setLayers(layersRef.current);
  }, []);

  /** Ends a run: records the verdict on screen and hands it up to be saved. */
  const settle = useCallback(
    (verdict: 'passed' | 'failed') => {
      setStatus(verdict);
      onRunComplete?.({
        status: verdict,
        layers: layersRef.current.map((l) => ({ status: l.status, message: l.message })),
        at: new Date().toISOString(),
      });
    },
    [onRunComplete],
  );

  /* ---- record attempt via API (stable, reads refs/latest via params) ---- */

  const recordAttempt = useCallback(
    async (
      allPassed: boolean,
      durationMs: number,
      testResults?: Array<{ name: string; passed: boolean; message: string }>,
    ) => {
      try {
        const result = await api.submitAttempt(
          projectId,
          stepIndex,
          files,
          durationMs,
          testResults,
        );
        if (allPassed && result.passed) {
          settle('passed');
          onPass(result.solutionFiles);
        } else {
          settle('failed');
        }
      } catch {
        // The server is the authority on whether a checkpoint passed: it re-runs
        // the static layers and owns the attempt record. If that call fails we
        // do not know the outcome, so the checkpoint does NOT advance — passing
        // a learner on a 500, a 429, or a dropped connection would let them skip
        // steps by going offline.
        updateLayer(2, {
          status: 'failed',
          message: 'Could not reach the server to record this attempt. Try again.',
        });
        settle('failed');
      }
    },
    [projectId, stepIndex, files, onPass, updateLayer, settle],
  );

  /* ---- sandbox callbacks ---- */

  const handleSandboxResult = useCallback(
    (result: {
      passed: boolean;
      results: Array<{ name: string; passed: boolean; message: string }>;
    }) => {
      const durationMs = Date.now() - startedAtRef.current;
      // The results travel to the server either way: it cannot run these tests
      // itself, so without them it would record a failing attempt as a pass.
      if (result.passed) {
        updateLayer(2, { status: 'passed', message: PASS_LABELS[2] });
        recordAttempt(true, durationMs, result.results);
      } else {
        const failedTests = result.results.filter((r) => !r.passed);
        const msg = failedTests.map((t) => t.message).join('; ');
        updateLayer(2, { status: 'failed', message: msg });
        recordAttempt(false, durationMs, result.results);
      }
    },
    [updateLayer, recordAttempt],
  );

  const handleSandboxError = useCallback(
    (message: string) => {
      const durationMs = Date.now() - startedAtRef.current;
      updateLayer(2, { status: 'failed', message });
      // A sandbox that could not run the tests is a failed run, and reported as
      // one rather than as an empty (and therefore passing) result set.
      recordAttempt(false, durationMs, [
        { name: 'sandbox', passed: false, message },
      ]);
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
    resetLayers();
    setSandboxProgress(null);
    onAttempt();
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
        // Recorded like any other failure. The server owns the attempt history
        // that the hint gate and the pacing model read, so a static failure
        // that never reaches it does not count towards unlocking a hint —
        // which is precisely when the learner needs one.
        await recordAttempt(false, Date.now() - startedAtRef.current);
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
        // See layer 1: a failed run is a failed run, wherever it fails.
        await recordAttempt(false, Date.now() - startedAtRef.current);
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
      const msg =
        err instanceof Error ? err.message : 'Unexpected error during verification.';
      const idx = layersRef.current.findIndex(
        (l) => l.status === 'running' || l.status === 'pending',
      );
      if (idx >= 0) updateLayer(idx, { status: 'failed', message: msg });
      settle('failed');
    }
  }, [files, checkpoint, updateLayer, resetLayers, recordAttempt, onAttempt, settle]);

  /* ---- sandbox input ----
     The files go over whole. Concatenating them into one string and handing
     that to the interpreter made every non-source file in the project — a
     requirements.txt, an index.html — a syntax error in the language of the
     step, which failed the checkpoint before a single test ran. */

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
                    ? 'var(--danger)'
                    : layer.status === 'passed'
                      ? 'var(--success)'
                      : 'var(--text-dim)',
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
            <li style={{ padding: '2px 0 0 18px', fontSize: 12, color: 'var(--text-faint)' }}>
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
        <span style={{ color: 'var(--success)', fontWeight: 600, fontSize: 14 }}>
          Checkpoint passed!
        </span>
      )}

      {status === 'failed' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button type="button" onClick={run}>
            Retry
          </button>
          {attemptCount > 0 && (
            <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>Attempt {attemptCount}</span>
          )}
        </div>
      )}

      {/* Sandbox — invisible iframe, only mounted when needed */}
      {showSandbox && checkpoint.runtime !== 'none' && (
        <SandboxFrame
          runtime={checkpoint.runtime}
          files={files}
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
