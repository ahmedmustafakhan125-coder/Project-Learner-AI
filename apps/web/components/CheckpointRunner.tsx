'use client';

import { useState, useCallback, useRef } from 'react';
import { verify } from '@ai-edu/runners';
import type { LayerResult } from '@ai-edu/runners';
import { preflightSubmission, type PreflightFailure } from '@ai-edu/core';
import { ApiError, type CheckpointRun } from '@ai-edu/api-client';
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
  /**
   * The whole project as it currently stands — this step's work plus every
   * file the earlier steps produced.
   *
   * This is what gets verified and what the sandbox mounts. A checkpoint asks
   * "does the project do the thing now", and a test that touches the page needs
   * the page, which lives in a file some earlier step created.
   */
  files: Array<{ path: string; contents: string }>;
  /**
   * Just this step's own files — what is recorded as the attempt.
   *
   * Kept separate from `files` because the step that owns a file is the step
   * that grades it: storing the inherited files here would make every step
   * claim authorship of the whole project, and `assembleProject` resolves the
   * finished repository by asking which step each file came from.
   *
   * The server does not trust this to be the whole picture — it merges the
   * earlier files back in from its own copy before verifying.
   */
  submittedFiles: Array<{ path: string; contents: string }>;
  /**
   * The scaffolding this step handed over.
   *
   * Needed to tell work from an untouched starting point, which is the single
   * most common junk submission and the one the old runner counted as a
   * real failed attempt.
   */
  starterFiles: Array<{ path: string; contents: string }>;
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

/**
 * The glyph in front of each layer row.
 *
 * Styling moved to the stylesheet: the pending dot was --text-faint on white,
 * which is invisible, and the running dot referenced a `cr-pulse` keyframe that
 * the component injected with its own inline <style> element on every render.
 */
function StatusDot({ status }: { status: LayerState['status'] }) {
  const glyph = status === 'passed' ? '✓' : status === 'failed' ? '✗' : null;
  return (
    <span className={`cp-dot cp-dot-${status}`} aria-hidden="true">
      {glyph}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function CheckpointRunner({
  projectId,
  stepIndex,
  checkpoint,
  files,
  submittedFiles,
  starterFiles,
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
  /*
   * Why a submission was refused before it became an attempt.
   *
   * Distinct from a failed run on purpose. A failure is work that did not pass;
   * a refusal is not work at all, and it is deliberately NOT recorded - the
   * hint ladder unlocks on attempt count, so counting junk was a way to buy
   * help without writing anything.
   */
  const [refusal, setRefusal] = useState<PreflightFailure | null>(null);
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
          submittedFiles,
          durationMs,
          testResults,
        );
        if (allPassed && result.passed) {
          settle('passed');
          onPass(result.solutionFiles);
        } else {
          settle('failed');
        }
      } catch (err) {
        /*
         * The server refused it as junk. It is the authority on that rule, and
         * it can refuse something this component let through - the browser
         * compares against the starter files it was handed, while the server
         * compares against the ones it stored.
         */
        if (err instanceof ApiError && err.code === 'not_an_attempt') {
          const body = err.payload as { message?: string; reason?: string; details?: string[] } | null;
          setRefusal({
            code: (body?.reason as PreflightFailure['code']) ?? 'unchanged',
            message: body?.message ?? 'That submission was not accepted.',
            details: body?.details ?? [],
          });
          setStatus('idle');
          resetLayers();
          return;
        }

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
    [projectId, stepIndex, submittedFiles, onPass, updateLayer, settle, resetLayers],
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
    /*
     * Is this an attempt at all?
     *
     * Runs before `onAttempt`, before the layers, and before anything reaches
     * the server. The same rule runs server-side as the authority - this copy
     * exists so the learner is told immediately rather than after a round trip.
     */
    const refused = preflightSubmission({
      submitted: submittedFiles,
      starter: starterFiles,
      requiredFiles: checkpoint.requiredFiles,
      requiredSymbols: checkpoint.requiredSymbols,
    });
    if (refused) {
      setRefusal(refused);
      setStatus('idle');
      resetLayers();
      return;
    }

    setRefusal(null);
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
      // A generator that finishes without yielding cannot produce a verdict.
      // Returning here without settling left `status` on 'running' forever —
      // a permanently disabled button with no way back but a page reload.
      if (layer1Result.done) {
        updateLayer(0, { status: 'failed', message: 'Verification did not run. Try again.' });
        settle('failed');
        return;
      }
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
      if (layer2Result.done) {
        updateLayer(1, { status: 'failed', message: 'Verification did not run. Try again.' });
        settle('failed');
        return;
      }
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
        // Not "auto-passed". Nothing was executed, and saying so is the honest
        // description - the file and symbol layers plus the submit gate are the
        // whole check for these steps.
        updateLayer(2, {
          status: 'passed',
          message: 'No runnable tests for this step — checked files and symbols only.',
        });
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
  }, [
    files,
    submittedFiles,
    starterFiles,
    checkpoint,
    updateLayer,
    resetLayers,
    recordAttempt,
    onAttempt,
    settle,
  ]);

  /* ---- sandbox input ----
     The files go over whole. Concatenating them into one string and handing
     that to the interpreter made every non-source file in the project — a
     requirements.txt, an index.html — a syntax error in the language of the
     step, which failed the checkpoint before a single test ran. */

  /* ---- render ---- */

  return (
    <div className="checkpoint-runner">
      {/*
        A refusal, not a failure.
        Worth the visual distinction: nothing was recorded, no attempt was
        spent, and the fix is always the same shape - write the code. Showing it
        as a failed run would tell the learner they tried and got it wrong.
      */}
      {refusal && (
        <div className="notice warn cp-refusal" role="status">
          <strong>Not submitted.</strong> {refusal.message}
          {refusal.details.length > 1 && (
            <ul className="cp-refusal-list">
              {refusal.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          )}
          <p className="muted">This does not count as an attempt.</p>
        </div>
      )}

      {/* Layer results */}
      {status !== 'idle' && (
        <ul className="cp-layers">
          {layers.map((layer, i) => (
            <li key={i} className={`cp-layer cp-layer-${layer.status}`}>
              <StatusDot status={layer.status} />
              <span>
                {layer.status === 'passed'
                  ? PASS_LABELS[i]
                  : layer.status === 'failed'
                    ? layer.message ?? 'Failed'
                    : LAYER_LABELS[i]}
              </span>
            </li>
          ))}
          {sandboxProgress && layers[2].status === 'running' && (
            <li className="cp-progress">{sandboxProgress}</li>
          )}
        </ul>
      )}

      {/*
        Action area.
        Every control here was a bare <button> with no class, so the one thing
        the learner has to press on this page rendered as raw browser chrome on
        a themed card. The verdict is announced politely rather than shouted,
        because it lands while focus is still in the editor.
      */}
      <div className="checkpoint-actions" aria-live="polite">
        {status === 'idle' && (
          <button type="button" className="btn primary" onClick={run}>
            Submit for checking
          </button>
        )}

        {status === 'running' && (
          <button type="button" className="btn primary" disabled>
            <span className="loading-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            Checking your work…
          </button>
        )}

        {status === 'passed' && (
          <>
            <span className="cp-verdict cp-verdict-passed">✓ Checkpoint passed</span>
            {/* Passing used to remove the control entirely, so a learner who
                kept editing afterwards had no way to verify the change. */}
            <button type="button" className="btn" onClick={run}>
              Check again
            </button>
          </>
        )}

        {status === 'failed' && (
          <>
            <button type="button" className="btn primary" onClick={run}>
              Retry checkpoint
            </button>
            <span className="cp-verdict cp-verdict-failed">Not passing yet.</span>
          </>
        )}

        {attemptCount > 0 && <span className="cp-attempts">Attempt {attemptCount}</span>}
      </div>

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
