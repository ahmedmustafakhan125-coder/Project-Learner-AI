'use client';

import { useEffect, useRef, useState } from 'react';

import { SANDBOX_TIMEOUT_MS, type SandboxInMessage, type SandboxOutMessage } from '../lib/sandbox-protocol';

/**
 * The practice page, live.
 *
 * It used to be a `srcdoc` frame, which inherits the app's CSP: the page drew,
 * but every inline script was refused, so "Run & Check" never did anything. It
 * now loads the /sandbox route, which carries its own policy, and hands the
 * page over with the same `exec-web` message the checkpoint runner uses — no
 * tests, so what stays behind is the page itself, running. Containment is the
 * same as before: `sandbox="allow-scripts"` gives the frame an opaque origin.
 */
export function PracticePreview({ html }: { html: string }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // A script that never returns cannot be stopped from outside; dropping the
  // frame is what ends it, as SandboxFrame does on its timeout.
  const [stopped, setStopped] = useState(false);

  useEffect(() => {
    setProblem(null);
    setStopped(false);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clear = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };

    const onMessage = (ev: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || ev.source !== frame.contentWindow) return;
      const msg = ev.data as SandboxOutMessage;
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'ready') {
        const run: SandboxInMessage = { type: 'exec-web', files: [{ path: 'index.html', contents: html }], tests: [] };
        frame.contentWindow?.postMessage(run, '*');
        clear();
        timer = setTimeout(() => {
          setStopped(true);
          setProblem('The exercise page kept running for 10 seconds, so the preview was stopped.');
        }, SANDBOX_TIMEOUT_MS);
      } else if (msg.type === 'result') {
        clear();
      } else if (msg.type === 'error') {
        clear();
        setProblem(msg.message);
      }
    };

    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      clear();
    };
  }, [html]);

  return (
    <div className="exercise">
      <div className="exercise-head">
        <span className="exercise-dot" aria-hidden="true" />
        Isolated sandbox preview
      </div>
      {!stopped && (
        <iframe
          key={html}
          ref={frameRef}
          title="Practice exercise"
          sandbox="allow-scripts"
          src="/sandbox?runtime=web"
          referrerPolicy="no-referrer"
          className="exercise-frame"
        />
      )}
      {problem && <p className="exercise-note">{problem}</p>}
    </div>
  );
}
