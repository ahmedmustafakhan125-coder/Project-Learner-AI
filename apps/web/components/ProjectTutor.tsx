'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { TutorGate, TutorTranscriptTurn } from '@ai-edu/api-client';

import { renderMarkdown } from '@/lib/markdown';
import { splitFences } from './AgentTabs';
import { api } from '../lib/api';

/**
 * The tutor, docked beside the work.
 *
 * A side panel rather than a floating bubble, for the same reason an editor
 * puts its assistant in a rail: the learner is reading their code and the
 * answer at the same time, and a bubble that covers the thing being discussed
 * makes them close it to look, then reopen it to read.
 *
 * The conversation spans the project, not the step. Asking "why did we do it
 * that way in step 3" while working on step 7 is one question about one
 * project, and a per-step transcript would throw away exactly the context that
 * makes it worth having. Each turn is tagged with where it was asked so the
 * thread can show the move.
 *
 * Streaming state lives HERE and not in the collapsed/expanded body, because a
 * stream has to survive the panel being closed — the same lesson `AgentChat`
 * learned about switching tabs mid-answer.
 */

/* ---- how wide the drawer is ----
 *
 * 400px is a good width for a question and a poor one for an answer with a
 * build file in it. Code wraps rather than clipping (see globals.css), so
 * nothing is ever hidden at any width - this is about not having to read a
 * CMake block four words at a time.
 */

const MIN_WIDTH = 320;
const MAX_WIDTH = 760;
/** Left visible behind the drawer, so it never becomes a full-page takeover. */
const PAGE_MARGIN = 80;
const WIDTH_KEY = 'tutor:width';
/** Keyboard resize increment, for the same handle. */
const RESIZE_STEP = 24;

function clampWidth(px: number): number {
  const ceiling = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - PAGE_MARGIN));
  return Math.round(Math.min(ceiling, Math.max(MIN_WIDTH, px)));
}

/**
 * The remembered width.
 *
 * `null` means "whatever the stylesheet says", which is also what the server
 * renders - reading localStorage during render would hydrate to a different
 * width than the HTML that came over the wire.
 */
function useTutorWidth(active: boolean) {
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    if (!active) return;
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(WIDTH_KEY);
    } catch {
      // Private browsing, or storage turned off. The default is fine.
    }
    const parsed = stored === null ? Number.NaN : Number.parseInt(stored, 10);
    if (Number.isFinite(parsed)) setWidth(clampWidth(parsed));
  }, [active]);

  // A window narrowed after the width was chosen would otherwise leave the
  // drawer wider than the screen, with the page behind it gone.
  useEffect(() => {
    if (!active) return;
    const onResize = () => setWidth((w) => (w === null ? null : clampWidth(w)));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [active]);

  const commit = useCallback((next: number) => {
    const clamped = clampWidth(next);
    setWidth(clamped);
    try {
      window.localStorage.setItem(WIDTH_KEY, String(clamped));
    } catch {
      // Not worth telling anyone about: the width still applies this session.
    }
    return clamped;
  }, []);

  return { width, setWidth, commit };
}

export interface ProjectTutorProps {
  projectId: string;
  /** The step being looked at, or null in the finished-project view. */
  stepIndex: number | null;
  /**
   * Bumped by the page whenever an attempt or a hint changes the gate inputs.
   *
   * The panel and the hint ladder read the same counters, so pressing submit
   * has to move what the tutor says is outstanding. Without this the panel
   * would keep reporting the state it loaded when it opened.
   */
  progressToken?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  stepIndex: number | null;
  revealedCode?: boolean;
}

export function ProjectTutor({
  projectId,
  stepIndex,
  progressToken = 0,
  open,
  onOpenChange,
}: ProjectTutorProps) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<TutorGate | null>(null);
  const [draft, setDraft] = useState('');
  const [loaded, setLoaded] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const { width, setWidth, commit } = useTutorWidth(open);
  const [dragging, setDragging] = useState(false);

  /*
   * The drag itself.
   *
   * Pointer capture rather than window listeners: the pointer leaves the 6px
   * grip immediately and every move after that has to keep arriving. Capture
   * also means the release is delivered even if it happens over the iframe in
   * the editor, which swallows events that go to the document.
   */
  const onGripDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
      document.body.dataset.tutorResizing = 'true';
    },
    [],
  );

  const onGripMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      // The panel is pinned to the right edge, so its width is the distance
      // from the pointer to that edge.
      setWidth(clampWidth(window.innerWidth - e.clientX));
    },
    [dragging, setWidth],
  );

  const endDrag = useCallback(() => {
    if (!dragging) return;
    setDragging(false);
    delete document.body.dataset.tutorResizing;
    // Written once, at the end - not on every pointermove.
    if (width !== null) commit(width);
  }, [dragging, width, commit]);

  // A drag interrupted by the panel closing (or the component unmounting) must
  // not leave the whole page stuck with a col-resize cursor and no selection.
  useEffect(() => {
    if (open) return;
    delete document.body.dataset.tutorResizing;
  }, [open]);
  useEffect(() => () => { delete document.body.dataset.tutorResizing; }, []);

  /* ---- transcript, loaded once the panel is first opened ----
     A learner who never opens the tutor should not pay for the fetch. */
  useEffect(() => {
    if (!open || loaded) return;
    setLoaded(true);
    api
      .getTutorThread(projectId)
      .then((rows: TutorTranscriptTurn[]) =>
        setTurns(
          rows.map((row) => ({
            role: row.role,
            content: row.content,
            stepIndex: row.stepIndex,
            revealedCode: row.revealedCode,
          })),
        ),
      )
      .catch(() => {
        // A missing transcript is not worth an error banner over: they can
        // still ask, and the conversation starts from here.
      });
  }, [open, loaded, projectId]);

  /* ---- how close this step is to earning the code ---- */
  useEffect(() => {
    if (!open || stepIndex === null) {
      setGate(null);
      return;
    }
    let cancelled = false;
    api
      .getTutorGate(projectId, stepIndex)
      .then((next) => {
        if (!cancelled) setGate(next);
      })
      .catch(() => {
        if (!cancelled) setGate(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId, stepIndex, progressToken]);

  // Follow the stream, but only while it is running: yanking the view down
  // while someone re-reads an earlier answer is worse than not scrolling.
  useEffect(() => {
    if (!busy || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [busy, streaming, turns.length]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(async () => {
    const message = draft.trim();
    if (!message || busy) return;

    setDraft('');
    setError(null);
    setBusy(true);
    setStreaming('');
    setTurns((prev) => [...prev, { role: 'user', content: message, stepIndex }]);

    const controller = new AbortController();
    abortRef.current = controller;

    let answer = '';
    let revealed = false;

    try {
      for await (const event of api.askTutor({
        projectId,
        stepIndex,
        message,
        signal: controller.signal,
      })) {
        if (event.kind === 'meta') {
          revealed = event.unlocked;
          // The server recomputed the gate for this ask, so its answer is
          // fresher than the one the panel loaded.
          setGate((prev) =>
            prev ? { ...prev, unlocked: event.unlocked, missing: event.missing } : prev,
          );
        } else if (event.kind === 'delta') {
          answer += event.text;
          setStreaming(answer);
        } else if (event.kind === 'done') {
          answer = event.text || answer;
        } else {
          setError(event.message);
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'The tutor could not be reached.');
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      setStreaming(null);
      // Kept even when partial: it was on their screen either way, and the
      // server has stored the same text.
      if (answer) {
        setTurns((prev) => [
          ...prev,
          { role: 'assistant', content: answer, stepIndex, revealedCode: revealed },
        ]);
      }
    }
  }, [draft, busy, projectId, stepIndex]);

  if (!open) {
    return (
      <button
        type="button"
        className="tutor-rail"
        onClick={() => onOpenChange(true)}
        aria-label="Open the tutor"
        title="Ask the tutor about this project"
      >
        <span className="tutor-rail-icon" aria-hidden="true">
          ✦
        </span>
        <span className="tutor-rail-label">Tutor</span>
      </button>
    );
  }

  return (
    <aside
      className="tutor-panel"
      aria-label="Project tutor"
      style={width === null ? undefined : ({ '--tutor-w': `${width}px` } as CSSProperties)}
    >
      {/*
        Drag to widen, arrow keys to nudge, double-click to reset.

        A separator rather than a button: it does not do a thing, it sets a
        value, and a screen reader announcing "button" here would be a lie
        about what pressing it does.
      */}
      <div
        className="tutor-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the tutor"
        aria-valuenow={width ?? undefined}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        data-dragging={dragging ? 'true' : undefined}
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={() => commit(400)}
        onKeyDown={(e) => {
          // Left widens, because the panel grows leftwards from the edge.
          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            commit((width ?? 400) + RESIZE_STEP);
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            commit((width ?? 400) - RESIZE_STEP);
          }
        }}
      />

      {/*
        The way out: a tab hanging off the edge the panel is covering.

        It was a full-height strip, which read as a wall rather than a control
        and made the panel look 26px narrower than it was. A small tab in the
        same place, and of the same shape, as the rail that opens the drawer
        means one object in one position - press it to open, press it to close
        - instead of two unrelated affordances at opposite ends of the panel.
      */}
      <button
        type="button"
        className="tutor-close-handle"
        onClick={() => onOpenChange(false)}
        aria-label="Close the tutor"
        title="Close the tutor"
      >
        <span aria-hidden="true">&rsaquo;</span>
      </button>

      <div className="tutor-body">
        <header className="tutor-head">
          <span className="tutor-title">
            <span aria-hidden="true">✦</span> Tutor
          </span>
          <button
            type="button"
            className="tutor-collapse"
            onClick={() => onOpenChange(false)}
            aria-label="Close the tutor"
            title="Close"
          >
            ✕
          </button>
        </header>

        <div className="tutor-log" ref={logRef}>
          {/*
            Inside the scroller, not beside it. As a sibling it was a second
            unscrollable block in the column, so on a short window it pushed
            the composer down instead of scrolling.
          */}
          {turns.length === 0 && !streaming && (
            <div className="tutor-empty">
              <p>
                I can see this project and every file you have written in it. Ask me what is
                going wrong, what something means, or what to try next.
              </p>
              <p className="muted">
                I will not write the step&apos;s code for you until you have really had a go
                at it — everything else is fair game.
              </p>
            </div>
          )}

          {turns.map((turn, i) => {
            const movedStep = i > 0 && turns[i - 1]!.stepIndex !== turn.stepIndex;
            return (
              <div key={i}>
                {movedStep && turn.stepIndex !== null && (
                  <div className="tutor-divider">Step {turn.stepIndex + 1}</div>
                )}
                <div className={`tutor-turn tutor-turn-${turn.role}`}>
                  <span className="tutor-who">{turn.role === 'user' ? 'You' : 'Tutor'}</span>
                  {turn.role === 'user' ? (
                    <p className="tutor-text">{turn.content}</p>
                  ) : (
                    <div className="tutor-text answer">
                      <Rendered text={turn.content} keyPrefix={`t${i}`} />
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {streaming !== null && (
            <div className="tutor-turn tutor-turn-assistant">
              <span className="tutor-who">Tutor</span>
              {streaming ? (
                <div className="tutor-text answer">
                  <Rendered text={streaming} keyPrefix="ts" />
                  <span className="caret" aria-hidden="true" />
                </div>
              ) : (
                <p className="loading-line">
                  <span className="loading-dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  Reading your code…
                </p>
              )}
            </div>
          )}
        </div>

        {error && <div className="notice error tutor-error">{error}</div>}

        {/*
          What the gate is still waiting for.
          A composite score is opaque by nature - a number going up tells nobody
          what to do - so the panel shows the outstanding items instead, and the
          tutor never has to refuse without saying why.
        */}
        {gate && !gate.unlocked && gate.missing.length > 0 && (
          <div className="tutor-gate">
            <strong>Code is held back for now.</strong>
            <span className="muted"> Still to go: {gate.missing.join(', ')}.</span>
          </div>
        )}
        {gate?.unlocked && (
          <div className="tutor-gate unlocked">
            <strong>Code is open on this step.</strong>
            <span className="muted"> Ask for the part you are stuck on.</span>
          </div>
        )}

        <div className="tutor-composer">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              stepIndex === null
                ? 'Ask about the finished project…'
                : `Ask about step ${stepIndex + 1}…`
            }
            rows={2}
            disabled={busy}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter is a newline. Most questions are a line.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {busy ? (
            <button
              type="button"
              className="btn danger"
              onClick={() => abortRef.current?.abort()}
            >
              ■ Stop
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              onClick={() => void send()}
              disabled={!draft.trim()}
            >
              Ask
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

/**
 * Model output, rendered.
 *
 * Fences are split out by hand and rendered as plain text nodes. No Markdown
 * library, per the invariant in CONTEXT.md — one with raw-HTML support would be
 * a direct XSS path from model output, and this component renders more model
 * output than anything else on the page.
 */
function Rendered({ text, keyPrefix }: { text: string; keyPrefix: string }) {
  return (
    <>
      {splitFences(text).map((block, i) =>
        block.type === 'code' ? (
          <pre key={`${keyPrefix}c${i}`} data-lang={block.lang || undefined}>
            <code>{block.content}</code>
          </pre>
        ) : (
          <div key={`${keyPrefix}p${i}`}>{renderMarkdown(block.content, `${keyPrefix}${i}`)}</div>
        ),
      )}
    </>
  );
}
