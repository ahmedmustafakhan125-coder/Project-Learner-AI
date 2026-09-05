'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import {
  SANDBOX_TIMEOUT_MS,
  type SandboxFile,
  type SandboxInMessage,
  type SandboxOutMessage,
} from '@/lib/sandbox-protocol';

interface SandboxFrameProps {
  runtime: 'web' | 'python';
  /** The whole submission. The sandbox decides what of it is executable. */
  files: SandboxFile[];
  tests: Array<{ name: string; code: string; failureMessage: string }>;
  onProgress?: (message: string) => void;
  onResult: (result: {
    passed: boolean;
    results: Array<{ name: string; passed: boolean; message: string }>;
  }) => void;
  onError: (message: string) => void;
  /** Increment to re-run (acts like a key). */
  trigger: number;
}

/**
 * Invisible execution sandbox.
 *
 * Security: the iframe uses `sandbox="allow-scripts"` with NO
 * `allow-same-origin`. This gives the frame an opaque origin so it cannot
 * reach the parent's DOM, cookies, or storage — a load-bearing constraint.
 */
export function SandboxFrame({
  runtime,
  files,
  tests,
  onProgress,
  onResult,
  onError,
  trigger,
}: SandboxFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readyRef = useRef(false);
  /* Set when a run was asked for before the frame could serve it — either
     because it has not loaded yet, or because we just replaced it on purpose.
     The `ready` handler is what finally fires it. */
  const pendingExecRef = useRef(false);

  /*
   * `generation` forces a genuinely new iframe. It is bumped on timeout, where
   * the old frame is stuck in a loop we cannot interrupt from outside, and on a
   * runtime change. Using it as a React `key` means React unmounts and remounts
   * the element itself — the previous code called frame.remove() by hand, which
   * detaches a node React still believes it owns and leaves the ref permanently
   * null, so every later run silently did nothing.
   */
  const [generation, setGeneration] = useState(0);

  /* ---- message handler ---- */
  const handleMessage = useCallback(
    (ev: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || ev.source !== frame.contentWindow) return;

      const msg = ev.data as SandboxOutMessage;
      if (!msg || typeof msg !== 'object') return;

      switch (msg.type) {
        case 'ready':
          readyRef.current = true;
          if (pendingExecRef.current) {
            pendingExecRef.current = false;
            execRef.current();
          }
          break;
        case 'progress':
          onProgress?.(msg.message);
          break;
        case 'result':
          clearTimer();
          onResult(msg);
          break;
        case 'error':
          clearTimer();
          onError(msg.message);
          break;
      }
    },
    [onProgress, onResult, onError],
  );

  /* ---- timer helpers ---- */
  function clearTimer() {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function startTimer() {
    clearTimer();
    timerRef.current = setTimeout(() => {
      killFrame();
      onError('Code execution timed out — possible infinite loop');
    }, SANDBOX_TIMEOUT_MS);
  }

  /* ---- kill the iframe (used on timeout) ---- */
  //
  // A synchronous infinite loop cannot be interrupted from the parent, so the
  // only way to stop it is to destroy its execution context. Remounting via
  // `key` lets React do that: it drops the old element (killing the loop) and
  // builds a fresh one, so the next run has a working frame to talk to.
  function killFrame() {
    clearTimer();
    readyRef.current = false;
    iframeRef.current = null;
    setGeneration((g) => g + 1);
  }

  /* ---- send exec message to the sandbox ---- */
  const exec = useCallback(() => {
    const frame = iframeRef.current;
    if (!frame?.contentWindow) return;

    const msg: SandboxInMessage =
      runtime === 'python'
        ? { type: 'exec-python', files, tests }
        : { type: 'exec-web', files, tests };

    frame.contentWindow.postMessage(msg, '*');
    startTimer();
  }, [runtime, files, tests]);

  // `handleMessage` is registered once per mount and must not be rebuilt every
  // time the files change, so it reaches `exec` through a ref rather than
  // closing over it.
  const execRef = useRef(exec);
  execRef.current = exec;

  /* ---- mount / unmount lifecycle ---- */
  useEffect(() => {
    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
      clearTimer();
    };
    // handleMessage is stable via useCallback, so this runs once per mount.
  }, [handleMessage]);

  /* ---- re-run when trigger changes ---- */
  useEffect(() => {
    if (trigger === 0) return; // skip the initial render

    /*
     * The web sandbox gets a brand-new document for every run.
     *
     * Its learner scripts are real <script> elements now, so top-level `const`,
     * `let` and `class` declarations land in the frame's global lexical scope
     * and stay there for the life of the document. Re-running the same
     * submission in the same frame would fail with "Identifier 'todos' has
     * already been declared" — reported against the learner's file, for a
     * mistake they did not make. The first attempt would pass and every one
     * after it would not, which is the worst possible shape for this bug.
     *
     * Remounting is cheap here: the document is a few kilobytes of static HTML
     * with no runtime to download. Python is deliberately NOT remounted — that
     * reload is Pyodide, several seconds of wasm, and PY_LOAD already evicts
     * the previous run's modules from sys.modules.
     */
    if (runtime === 'web') {
      readyRef.current = false;
      pendingExecRef.current = true;
      setGeneration((g) => g + 1);
      return;
    }

    if (readyRef.current) {
      exec();
      return;
    }
    // Not loaded yet. `ready` will fire it.
    pendingExecRef.current = true;
    // Intentionally keyed on the run edge, not on everything `exec` closes
    // over: this is "run now", not a subscription.
  }, [trigger, runtime]);

  return (
    <iframe
      key={`${runtime}-${generation}`}
      ref={iframeRef}
      sandbox="allow-scripts"
      src={`/sandbox?runtime=${runtime}`}
      title="code-sandbox"
      aria-hidden
      style={{
        width: 0,
        height: 0,
        border: 'none',
        position: 'absolute',
        visibility: 'hidden',
        pointerEvents: 'none',
      }}
    />
  );
}
