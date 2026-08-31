'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import {
  SANDBOX_TIMEOUT_MS,
  type SandboxInMessage,
  type SandboxOutMessage,
} from '@/lib/sandbox-protocol';

interface SandboxFrameProps {
  runtime: 'web' | 'python';
  code: string;
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
  code,
  tests,
  onProgress,
  onResult,
  onError,
  trigger,
}: SandboxFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readyRef = useRef(false);

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
        ? { type: 'exec-python', code, tests }
        : { type: 'exec-web', code, tests };

    frame.contentWindow.postMessage(msg, '*');
    startTimer();
  }, [runtime, code, tests]);

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

    if (readyRef.current) {
      exec();
    } else {
      // Sandbox not ready yet — wait for `ready`, then exec once.
      const waitForReady = (ev: MessageEvent) => {
        const frame = iframeRef.current;
        if (!frame || ev.source !== frame.contentWindow) return;
        if (ev.data?.type === 'ready') {
          readyRef.current = true;
          window.removeEventListener('message', waitForReady);
          exec();
        }
      };
      window.addEventListener('message', waitForReady);
      // Cleanup if component unmounts before ready fires.
      return () => window.removeEventListener('message', waitForReady);
    }
    // Intentionally keyed on `trigger` alone: this effect is the "run now" edge,
    // not a subscription to every value `exec` happens to close over.
  }, [trigger]);

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
