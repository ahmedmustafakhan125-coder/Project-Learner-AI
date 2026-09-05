'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { SourceFile, StepContent, StepProgressPatch } from '@ai-edu/api-client';

import { composeWorkspace } from '@ai-edu/core';

import { api } from '../lib/api';

import { splitFences } from './AgentTabs';
import { renderMarkdown } from '@/lib/markdown';
import { CodeEditor } from './CodeEditor';
import { CheckpointRunner } from './CheckpointRunner';
import { ErrorBoundary } from './ErrorBoundary';
import { HintDrawer } from './HintDrawer';

/**
 * One tutorial step.
 *
 * The ordering is the pedagogy: instructions first, then the learner writes the
 * code, and only then the explanation and alternatives. Showing "why this
 * approach" before they have wrestled with the problem wastes the explanation —
 * it lands as trivia instead of as an answer to a question they were asking.
 *
 * So the explanation and alternatives are collapsed by default, with the reason
 * stated rather than hidden.
 */

/**
 * How long the learner has to stop typing before their work is saved.
 *
 * Short enough that closing the tab mid-thought loses at most a sentence, long
 * enough that a burst of typing is one request rather than fifty.
 */
const SAVE_DEBOUNCE_MS = 1_000;

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface StepViewProps {
  step: StepContent;
  projectId: string;
  /**
   * False until the previous step passes.
   *
   * A locked step is READABLE — the instructions, the starting files and what
   * it is for are all shown, because seeing what is coming is genuinely useful
   * and hiding it makes the project feel like a corridor. What closes is the
   * work: the editor, the checkpoint, the hints and the explanation. The server
   * enforces the same rule; this is the part the learner can see.
   */
  locked?: boolean;
  /** The step that has to be passed first. Shown in the lock banner. */
  blockedBy?: number | null;
  /**
   * Reports a saved draft back to whoever holds the step.
   *
   * The project page caches steps and this component is keyed per step, so
   * without this a learner who switches steps and returns is remounted against
   * the copy fetched at page load — their work would look lost until a reload,
   * even though the server has it.
   */
  onDraftSaved?: (files: SourceFile[]) => void;
  /**
   * Fired when this step's checkpoint passes.
   *
   * The project page advances the enrollment on it, which is what unlocks the
   * next step. Without this the frontier never moves: the advance endpoint has
   * existed since the beginning and nothing has ever called it.
   */
  onPassed?: () => void;
  /**
   * Fired when something the tutor's gate reads has changed.
   *
   * Attempts and spent hints feed both the hint ladder and the tutor's reveal,
   * so the panel has to be told when they move or it keeps reporting the state
   * it loaded when it opened.
   */
  onGateInputChanged?: () => void;
  /**
   * Reports state the page caches, so it survives leaving the step.
   *
   * The project page keeps expanded steps in a map and this component is keyed
   * per step, so switching away unmounts it and coming back remounts against
   * the object fetched at page load. Everything the learner spent in between —
   * hints opened, the explanation revealed, the checkpoint passed — was read
   * back from that stale copy and appeared to have been undone. It was still
   * on the server; it just was not on screen until a reload.
   */
  onStateChange?: (patch: Partial<StepContent>) => void;
  /**
   * Write this step again, because it came out wrong.
   *
   * A step was generated once and the cached copy served forever, so a bad
   * expansion — a file it never wrote, a checkpoint nothing can satisfy —
   * left the learner stuck on it with no way forward but abandoning the
   * project. The server repairs what it can detect on its own; this is for
   * everything only a person notices.
   */
  onRegenerate?: () => void;
  /** Opens the tutor panel. The page owns whether it is showing. */
  onAskTutor?: () => void;
}

export function StepView({
  step,
  projectId,
  locked = false,
  blockedBy = null,
  onDraftSaved,
  onPassed,
  onGateInputChanged,
  onStateChange,
  onRegenerate,
  onAskTutor,
}: StepViewProps) {
  // Everything below is seeded from the server. A step the learner has already
  // worked on reopens where they left it: the explanation they unlocked stays
  // unlocked, the checkpoint keeps its verdict, the hints they spent stay open.
  /*
   * Passing reveals the explanation, so a passed step reopens with it showing.
   *
   * Seeded from both, not just `step.revealed`: a step passed before this
   * behaviour existed never had the flag written, and would otherwise still
   * present the learner with a button to reveal something they had earned
   * weeks ago.
   */
  const [revealed, setRevealed] = useState(step.revealed || step.passed);
  // Their own work if they have started this step, the untouched scaffolding if
  // not. Before drafts were saved this always reset to the starter files, so
  // reopening a project quietly discarded everything they had written.
  const [editorFiles, setEditorFiles] = useState(step.draftFiles ?? step.starterFiles);
  const [passed, setPassed] = useState(step.passed);
  const [hintsOpened, setHintsOpened] = useState<number[]>(step.hintsOpened);
  // Both seeded from the server. The hint gate is enforced there against the
  // stored attempt history, so a client that restarts its count at zero on
  // every mount keeps hints locked that the learner has already earned.
  const [attemptCount, setAttemptCount] = useState(step.attemptCount);
  /*
   * When this step's hint clock started.
   *
   * Seeded from `startedAt`, not from the first attempt. The old seed made the
   * ladder's "or N minutes" branch dead for the learner it exists for: someone
   * who cannot work out how to begin has submitted nothing, so there was no
   * clock and no hint ever opened on time.
   */
  const [startedAt, setStartedAt] = useState<number | null>(
    step.startedAt
      ? new Date(step.startedAt).getTime()
      : step.firstAttemptAt
        ? new Date(step.firstAttemptAt).getTime()
        : null,
  );

  const hasCheckpoint = step.checkpoint && step.checkpoint.runtime !== undefined;

  /*
   * The project around this step.
   *
   * `editorFiles` is only what this step owns; `priorFiles` is everything the
   * earlier steps built. The rules for combining them - own files first, own
   * copy wins on a shared path, paths normalised - live in `composeWorkspace`
   * because getting the order wrong is invisible: the tab bar simply opens on
   * somebody else's read-only file and the editor refuses to type.
   */
  const workspace = composeWorkspace({
    ownFiles: editorFiles,
    priorFiles: step.priorFiles,
  });
  const ownPaths = new Set(workspace.ownPaths);

  /* ---- saving ----
     The editor is the learner's workspace, not a submission, so it saves on a
     debounce as they type. Everything else here — unlocking the explanation,
     opening a hint, finishing a run — is a single fact and goes immediately. */
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const pendingRef = useRef<SourceFile[] | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Keeps the page's cached copy of this step in step with what was saved. */
  const reportRef = useRef(onStateChange);
  reportRef.current = onStateChange;

  const persist = useCallback(
    (patch: StepProgressPatch) => {
      /*
       * Reported optimistically, alongside the write rather than after it.
       *
       * The local state has already moved, so the cache should match what is
       * on screen. A failed write costs a re-click next visit either way, and
       * waiting for the round trip would leave the cache stale for exactly as
       * long as it takes a learner to click a hint and switch steps.
       */
      const cached: Partial<StepContent> = {};
      if (patch.files) cached.draftFiles = patch.files;
      if (patch.revealed) cached.revealed = true;
      if (patch.lastRun !== undefined) cached.lastRun = patch.lastRun;
      if (patch.hintsOpened) cached.hintsOpened = patch.hintsOpened;
      if (Object.keys(cached).length > 0) reportRef.current?.(cached);

      void api.saveProgress(projectId, step.stepIndex, patch).catch(() => {
        // Losing one of these costs the learner a re-click on their next visit,
        // not their work. The editor's own save state reports separately.
      });
    },
    [projectId, step.stepIndex],
  );

  const flush = useCallback(async () => {
    const files = pendingRef.current;
    if (!files) return;
    pendingRef.current = null;

    setSaveState('saving');
    try {
      await api.saveProgress(projectId, step.stepIndex, { files });
      setSaveState('saved');
      onDraftSaved?.(files);
    } catch {
      // Deliberately not thrown away: the work is still in the editor, and the
      // next keystroke queues another save. Saying so beats a silent failure.
      setSaveState('error');
    }
  }, [projectId, step.stepIndex, onDraftSaved]);

  const queueSave = useCallback(
    (files: SourceFile[]) => {
      pendingRef.current = files;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  // Leaving the step is the one moment a debounce cannot cover: without this,
  // switching steps within the debounce window drops the last edits.
  //
  // Read through a ref so this runs on unmount and nothing else. Depending on
  // `flush` directly would re-run the cleanup on every render that changes its
  // identity, firing a save mid-debounce on each keystroke.
  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      void flushRef.current();
    },
    [],
  );

  /*
   * The step is open in front of them: start the clock.
   *
   * Sent on mount rather than on the first edit, because the learner who most
   * needs a timed hint is the one who has not worked out what to type. The
   * server keeps the first value it is given, so a mount tomorrow does not
   * push the clock forward.
   *
   * Skipped when the step is locked (no editor is mounted) or already started.
   */
  useEffect(() => {
    if (locked || startedAt !== null) return;
    const now = Date.now();
    setStartedAt(now);
    reportRef.current?.({ startedAt: new Date(now).toISOString() });
    persist({ started: true });
    // Keyed on the step alone: this is the "opened" edge, fired once.
  }, [projectId, step.stepIndex, locked]);

  return (
    <article className="step">
      <header>
        <h2>{step.title}</h2>
        {step.objective && <p className="objective">{step.objective}</p>}
      </header>

      {locked && (
        <div className="lock-banner" role="status">
          <span className="lock-banner-icon" aria-hidden="true">🔒</span>
          <span>
            <strong>
              {blockedBy === null
                ? 'This step is not open yet.'
                : `Pass step ${blockedBy + 1} to start this one.`}
            </strong>{' '}
            You can read it now — it builds directly on the code from the step before, so the
            editor opens once that one passes.
          </span>
        </div>
      )}

      {step.pacingDirective && step.pacingDirective.adjustment !== 'hold' && (
        <div className="pacing-banner">{step.pacingDirective.reason}</div>
      )}

      <Markdownish text={step.instructionsMd} />

      {/*
        Shown only while the step is locked. Once the editor is mounted it holds
        these same files and the preview is just a second, staler copy of them.
      */}
      {locked && step.starterFiles.length > 0 && (
        <section className="starter">
          <h3>Starting files</h3>
          <p className="muted">
            The scaffolding is written for you. The part that matters is marked with a TODO.
          </p>
          {step.starterFiles.map((file) => (
            <div key={file.path} className="file">
              <div className="file-name">{file.path}</div>
              <pre>
                <code>{file.contents}</code>
              </pre>
            </div>
          ))}
        </section>
      )}

      {locked ? (
        /*
          Readable, not workable. Rendering a disabled editor here would still
          load Monaco and still autosave on any stray change, so the working
          half is not disabled — it is simply not mounted.
        */
        <section className="notice info locked-note">
          <strong>The editor opens when this step does.</strong> Your starting files are listed
          above, and nothing here is lost — this step keeps its own draft once you begin it.
        </section>
      ) : hasCheckpoint ? (
        <section className="checkpoint-section">
          <CodeEditor
            files={workspace.files}
            readOnlyPaths={workspace.readOnlyPaths}
            initialPath={workspace.initialPath}
            onChange={(files) => {
              // Only this step's files come back. A read-only tab cannot emit a
              // change, but filtering here means a future editor bug cannot
              // quietly promote an inherited file into this step's draft.
              const next = files.filter((file) => ownPaths.has(file.path));
              setEditorFiles(next);
              queueSave(next);
              if (!startedAt) setStartedAt(Date.now());
            }}
          />
          <DraftStatus state={saveState} />
          {/*
            The boundary exists so a crash in the runner or the sandbox bridge
            costs the learner the checkpoint, not the whole step — their code is
            in the editor above it.
          */}
          <ErrorBoundary>
            <CheckpointRunner
              projectId={projectId}
              stepIndex={step.stepIndex}
              checkpoint={step.checkpoint}
              /*
                The whole project goes to the sandbox — it builds a real page
                out of these files, and a test asserting on the markup is
                testing the project rather than this step's diff. Only
                `submittedFiles` is this step's own work; the server merges the
                earlier files back in from its own copy rather than trusting
                the browser's.
              */
              files={workspace.files}
              submittedFiles={editorFiles}
              starterFiles={step.starterFiles}
              attemptCount={attemptCount}
              onAttempt={() => {
                // Every run counts, not just the one that finally passes —
                // hints exist for the learner who is stuck, and gating them on
                // a pass would only ever unlock them once they no longer help.
                setAttemptCount((c) => {
                  const next = c + 1;
                  reportRef.current?.({ attemptCount: next });
                  return next;
                });
                setStartedAt((at) => at ?? Date.now());
                onGateInputChanged?.();
              }}
              onPass={() => {
                setPassed(true);
                // Cached too, or navigating away and back would present a
                // passed step as unattempted: hints re-locked, explanation
                // hidden, the checkpoint offering to run again.
                reportRef.current?.({ passed: true, revealed: true });
                /*
                 * The explanation opens itself now.
                 *
                 * It was always gated behind a second button the learner had to
                 * find and press after passing, which is a click asking "did
                 * you want the thing this step exists to teach?". The reason
                 * for holding it back is that an explanation read before the
                 * learner has wrestled with the problem lands as trivia - and
                 * passing IS the moment that stops being true.
                 */
                setRevealed(true);
                persist({ revealed: true });
                // Moves the enrollment forward, which is what opens the next
                // step. Fired here rather than inside the runner so the runner
                // stays a checkpoint and knows nothing about navigation.
                onPassed?.();
              }}
              initialRun={step.lastRun}
              onRunComplete={(run) => persist({ lastRun: run })}
            />
          </ErrorBoundary>
          <HintDrawer
            projectId={projectId}
            stepIndex={step.stepIndex}
            hintCount={step.hintCount}
            attemptCount={attemptCount}
            startedAt={startedAt}
            passed={passed}
            openedTiers={hintsOpened}
            onTierOpened={(tier) => {
              const next = [...new Set([...hintsOpened, tier])].sort();
              setHintsOpened(next);
              persist({ hintsOpened: next });
              onGateInputChanged?.();
            }}
          />
        </section>
      ) : (
        /* Fallback for steps without checkpoints */
        <section className="notice info">
          <strong>Write this step yourself.</strong> Build it in your own editor, then continue.
        </section>
      )}

      {/*
        Deliberately quiet, and placed after the work rather than beside it.
        Rewriting costs a generation and replaces instructions the learner may
        be halfway through, so it should be findable when something is wrong
        and easy to ignore when nothing is.
      */}
      {!locked && onRegenerate && (
        <div className="step-regenerate">
          <span className="muted">Something wrong with this step?</span>
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (
                window.confirm(
                  'Write this step again from scratch?\n\n' +
                    'The instructions, starting files and checkpoint are replaced. ' +
                    'Your own code is kept.',
                )
              ) {
                onRegenerate();
              }
            }}
          >
            Rewrite it
          </button>
        </div>
      )}

      <section className="reveal">
        {locked ? (
          <button className="btn" disabled>
            Open this step to see the explanation
          </button>
        ) : !revealed ? (
          hasCheckpoint && !passed ? (
            <button className="btn" disabled>
              Pass the checkpoint to see the explanation
            </button>
          ) : (
            /*
             * Only reachable on a step with nothing to run. A checkpoint step
             * reveals itself on passing, so there is no button left to press;
             * here there is no pass to wait for, and the learner saying they
             * have written it is the only signal available.
             */
            <button
              className="btn"
              onClick={() => {
                setRevealed(true);
                persist({ revealed: true });
              }}
            >
              I have written it — explain the approach
            </button>
          )
        ) : (
          <>
            <h3>Why this approach</h3>
            <Markdownish text={step.explanationMd} />

            {step.alternatives.length > 0 && (
              <>
                <h3>What else you could have used</h3>
                <div className="alternatives">
                  {step.alternatives.map((alt) => (
                    <div className="alternative" key={alt.name}>
                      <div className="alt-head">
                        <strong>{alt.name}</strong>
                        <span className="muted"> instead of {alt.insteadOf}</span>
                      </div>
                      <div className="alt-cols">
                        <div>
                          <div className="alt-label good">Pros</div>
                          <ul className="tight">
                            {alt.pros.map((pro) => (
                              <li key={pro}>{pro}</li>
                            ))}
                          </ul>
                        </div>
                        <div>
                          <div className="alt-label bad">Cons</div>
                          <ul className="tight">
                            {alt.cons.map((con) => (
                              <li key={con}>{con}</li>
                            ))}
                          </ul>
                        </div>
                      </div>
                      <div className="when">
                        <strong>Reach for it when:</strong> {alt.whenToUse}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
        {!revealed && (
          <p className="muted" style={{ marginTop: 8 }}>
            Held back on purpose — the explanation is far more useful once you have
            hit the problem yourself.
          </p>
        )}
      </section>

      {/*
        This used to send the learner to the four-specialist fan-out, and told
        them those specialists "already know what you are building". They do
        not: the fan-out gets the interview context and never sees a line of
        their code. The tutor does — the whole project, every file they have
        written — so this points there instead, and the claim is now true.
      */}
      {onAskTutor && (
        <p className="muted step-ask-tutor">
          Stuck?{' '}
          <button type="button" className="linklike" onClick={onAskTutor}>
            Ask the tutor
          </button>{' '}
          — it can see this project and every file you have written in it.
        </p>
      )}
    </article>
  );
}

/** Quiet by default — it only speaks up once there is something to say. */
function DraftStatus({ state }: { state: SaveState }) {
  if (state === 'idle') return null;

  const label =
    state === 'saving'
      ? 'Saving…'
      : state === 'saved'
        ? 'Work saved'
        : 'Could not save — your work is still here, and the next edit retries.';

  return (
    <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }} role="status">
      {label}
    </p>
  );
}

/**
 * Instructions and explanations, rendered.
 *
 * Still no Markdown library — model output is untrusted and any renderer with
 * raw-HTML support is an XSS path (CONTEXT.md invariant 5). `renderMarkdown`
 * builds React elements instead, so a tag in the source stays text because it
 * only ever becomes a text child. Fences are split out first so code keeps its
 * own block with a copy button.
 */
function Markdownish({ text }: { text: string }) {
  const blocks = splitFences(text);
  return (
    <div className="prose">
      {blocks.map((block, i) =>
        block.type === 'code' ? (
          <pre key={i} data-lang={block.lang || undefined}>
            <code>{block.content}</code>
          </pre>
        ) : (
          <Fragment key={i}>{renderMarkdown(block.content, `b${i}`)}</Fragment>
        ),
      )}
    </div>
  );
}
