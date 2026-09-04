'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CompiledQuery, InterviewQuestion, InterviewState } from '@ai-edu/core';
import { ApiError, type ModelOption, type ThreadSummary } from '@ai-edu/api-client';

import { AgentTabs, type AgentPanes, emptyPanes } from '../../components/AgentTabs';
import { ChatHistory } from '../../components/ChatHistory';
import { InterviewPanel } from '../../components/InterviewPanel';
import { AuthGate } from '../../components/AuthGate';
import { api } from '../../lib/api';

/**
 * The whole P1 flow on one page:
 *
 *   ask -> (interview, if context is missing) -> four streamed answers
 *
 * The interview stage is skipped entirely when the platform already knows
 * enough, which is the common case for a learner working inside a project.
 *
 * The left rail is the learner's saved conversations. Answers were always
 * persisted server-side; until now nothing read them back, so the page opened
 * blank every time and a question asked yesterday was unrecoverable.
 */

type Phase = 'idle' | 'interviewing' | 'awaiting_answers' | 'streaming' | 'done';

const QUICK_SUGGESTIONS = [
  'How do closures work in JavaScript and how do they impact memory?',
  'Explain async/await vs Promises with practical production patterns',
  'How to build a distributed rate limiter with Redis?',
  'Why do we need useEffect cleanup functions in React?',
];

export default function AskPage() {
  return (
    <AuthGate>
      <Ask />
    </AuthGate>
  );
}

function Ask() {
  const [query, setQuery] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [questions, setQuestions] = useState<InterviewQuestion[]>([]);
  const [state, setState] = useState<InterviewState | null>(null);
  const [panes, setPanes] = useState<AgentPanes>(emptyPanes);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState<string>('');

  /* ---- conversation history ---- */
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  /** The question the panes on screen belong to — the current one or a replayed one. */
  const [askedQuestion, setAskedQuestion] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    api
      .listModels()
      .then((list) => {
        setModels(list);
        if (list[0]) setModel(list[0].id);
      })
      .catch(() => setModels([]));
  }, []);

  const refreshThreads = useCallback(async () => {
    setThreadsLoading(true);
    setThreadsError(null);
    try {
      setThreads(await api.listThreads());
    } catch (err) {
      setThreadsError(err instanceof ApiError ? err.message : 'Could not load your history.');
    } finally {
      setThreadsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshThreads();
  }, [refreshThreads]);

  // Abort any in-flight fan-out when the page unmounts. Without this the
  // server keeps generating four answers nobody will ever read.
  useEffect(() => () => abortRef.current?.abort(), []);

  const runFanOut = useCallback(
    async (compiled: CompiledQuery, threadId: string | null) => {
      setPhase('streaming');
      setPanes(emptyPanes());
      setAskedQuestion(compiled.originalQuery);

      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;

      try {
        for await (const event of api.ask({
          compiled,
          threadId,
          ...(model ? { model } : {}),
          signal: controller.signal,
        })) {
          switch (event.kind) {
            case 'meta':
              // Follow-ups ride the same thread, so the rail keeps one row per
              // conversation rather than one row per question.
              if (event.threadId) setActiveThreadId(event.threadId);
              break;
            case 'start':
              setPanes((prev) => ({
                ...prev,
                [event.agent]: { ...prev[event.agent], status: 'streaming' },
              }));
              break;
            case 'delta':
              setPanes((prev) => ({
                ...prev,
                [event.agent]: {
                  ...prev[event.agent],
                  status: 'streaming',
                  text: prev[event.agent].text + event.text,
                },
              }));
              break;
            case 'done':
              setPanes((prev) => ({
                ...prev,
                [event.agent]: { ...prev[event.agent], status: 'complete' },
              }));
              break;
            case 'error':
              setPanes((prev) => ({
                ...prev,
                [event.agent]: { ...prev[event.agent], status: 'error', error: event.message },
              }));
              break;
            case 'fatal':
              setError(event.message);
              break;
            case 'finished':
              setPhase('done');
              break;
          }
        }
        // The rail is keyed on `updated_at`, which only moves once the fan-out
        // has written. Refreshing here is what puts the new conversation on top
        // (and gives a brand-new thread its title) without a page reload.
        void refreshThreads();
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(describe(err));
        setPhase('idle');
      }
    },
    [model, refreshThreads],
  );

  /**
   * Stop the four agents mid-answer.
   *
   * Aborting the request is what actually stops the spend: the server watches
   * for the socket closing and detaches its in-flight provider calls. Whatever
   * text already arrived is kept — a learner who stops early because they have
   * seen enough should not lose what they read.
   */
  const cancel = useCallback(() => {
    if (!abortRef.current) return;
    abortRef.current.abort();
    abortRef.current = null;

    setPanes((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next) as Array<keyof AgentPanes>) {
        if (next[key].status === 'streaming' || next[key].status === 'pending') {
          next[key] = { ...next[key], status: 'cancelled' };
        }
      }
      return next;
    });
    setPhase('done');
    setNotice('Generation stopped. Partial answers are kept below.');
    void refreshThreads();
  }, [refreshThreads]);

  const start = useCallback(
    async (customQuery?: string) => {
      const promptToUse = (customQuery ?? query).trim();
      if (!promptToUse) return;
      if (customQuery) setQuery(customQuery);

      setError(null);
      setNotice(null);
      setQuestions([]);
      setState(null);
      setPhase('interviewing');

      // Captured before the interview so an answer that lands after the learner
      // has switched conversations still files under the thread it started in.
      const threadId = activeThreadId;

      try {
        const result = await api.startInterview({ query: promptToUse, threadId });

        if (result.status === 'awaiting_answers') {
          setQuestions(result.questions);
          setState(result.state);
          setPhase('awaiting_answers');
          return;
        }

        if ('degraded' in result && result.degraded) {
          setNotice('Could not gather context, so this answer is based on your question alone.');
        }
        await runFanOut(result.compiled, threadId);
      } catch (err) {
        setError(describe(err));
        setPhase('idle');
      }
    },
    [query, runFanOut, activeThreadId],
  );

  const answer = useCallback(
    async (answers: Record<string, string>, skip: boolean) => {
      if (!state) return;
      setPhase('interviewing');
      const threadId = activeThreadId;

      try {
        const result = await api.continueInterview({ state, answers, skip });

        if (result.status === 'awaiting_answers') {
          setQuestions(result.questions);
          setState(result.state);
          setPhase('awaiting_answers');
          return;
        }

        setQuestions([]);
        await runFanOut(result.compiled, threadId);
      } catch (err) {
        setError(describe(err));
        setPhase('awaiting_answers');
      }
    },
    [state, runFanOut, activeThreadId],
  );

  /* ---- history navigation ---- */

  const startNew = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setActiveThreadId(null);
    setAskedQuestion(null);
    setPanes(emptyPanes());
    setQuestions([]);
    setState(null);
    setQuery('');
    setError(null);
    setNotice(null);
    setPhase('idle');
    setRailOpen(false);
  }, []);

  const openThread = useCallback(async (threadId: string) => {
    abortRef.current?.abort();
    abortRef.current = null;

    setActiveThreadId(threadId);
    setRailOpen(false);
    setQuestions([]);
    setState(null);
    setError(null);
    setNotice(null);
    setTranscriptLoading(true);

    try {
      const detail = await api.getThread(threadId);
      // The rail opens a conversation at its most recent question: that is what
      // the learner was last looking at, and older turns stay reachable by
      // scrolling the transcript back through the same thread.
      const latest = detail.turns[detail.turns.length - 1];

      if (!latest) {
        setAskedQuestion(detail.thread.title);
        setPanes(emptyPanes());
        setPhase('idle');
        return;
      }

      setAskedQuestion(latest.question);
      setPanes(
        Object.fromEntries(
          Object.entries(latest.panes).map(([agent, pane]) => [
            agent,
            { status: pane.status, text: pane.text, error: pane.error },
          ]),
        ) as AgentPanes,
      );
      setPhase('done');
    } catch (err) {
      setError(describe(err));
      setPhase('idle');
    } finally {
      setTranscriptLoading(false);
    }
  }, []);

  const removeThread = useCallback(
    async (threadId: string) => {
      // Optimistic: the row disappears immediately and comes back on refresh if
      // the delete failed, which beats a rail that freezes on every click.
      setThreads((prev) => prev.filter((thread) => thread.id !== threadId));
      if (threadId === activeThreadId) startNew();

      try {
        await api.deleteThread(threadId);
      } catch (err) {
        setThreadsError(err instanceof ApiError ? err.message : 'Could not delete that conversation.');
      } finally {
        void refreshThreads();
      }
    },
    [activeThreadId, startNew, refreshThreads],
  );

  const busy = phase === 'interviewing' || phase === 'streaming';
  const showResults = phase === 'streaming' || phase === 'done';
  const generationComplete = phase === 'done';

  return (
    <div className={`workspace ${railOpen ? 'rail-open' : ''}`}>
      <button
        type="button"
        className="rail-scrim"
        aria-label="Close history"
        tabIndex={railOpen ? 0 : -1}
        onClick={() => setRailOpen(false)}
      />

      <ChatHistory
        threads={threads}
        activeThreadId={activeThreadId}
        loading={threadsLoading}
        error={threadsError}
        busy={busy}
        onSelect={(id) => void openThread(id)}
        onNew={startNew}
        onDelete={(id) => void removeThread(id)}
        onRetry={() => void refreshThreads()}
      />

      <main className="workspace-main">
        <div className="shell">
          <button
            type="button"
            className="rail-toggle"
            aria-expanded={railOpen}
            onClick={() => setRailOpen((open) => !open)}
          >
            ☰ History
          </button>

          <header className="masthead">
            <h1>What shall we explore today?</h1>
            <div className="sub">
              Ask any programming or architecture problem. Four dedicated specialist agents reason
              and stream answers in parallel.
            </div>
          </header>

          <div className="lumina-command-bar">
            <div className="querybox search-glow">
              <textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Describe the concept, system problem, or code you want to master…"
                disabled={busy}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void start();
                }}
              />
              <div className="row">
                <div className="querybox-controls">
                  {models.length > 0 && (
                    <label className="model-picker">
                      <span className="model-picker-label">AI model</span>
                      <select
                        className="control"
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        disabled={busy}
                      >
                        {models.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                            {option.unpriced ? ' (unmetered)' : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {activeThreadId && (
                    <span className="thread-chip" title="Follow-ups are saved to this conversation">
                      ⟳ Continuing conversation
                    </span>
                  )}
                </div>

                <div className="querybox-actions">
                  <kbd className="kbd-hint">Ctrl/⌘ + Enter</kbd>
                  {phase === 'streaming' ? (
                    <button type="button" className="btn danger" onClick={cancel}>
                      ■ Stop generating
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn primary"
                      onClick={() => void start()}
                      disabled={busy || !query.trim()}
                    >
                      {phase === 'interviewing' ? (
                        <>
                          <span className="loading-dots" aria-hidden="true">
                            <i />
                            <i />
                            <i />
                          </span>
                          Analyzing…
                        </>
                      ) : (
                        'Run query'
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {phase === 'idle' && !transcriptLoading && (
              <div className="quick-prompts">
                {QUICK_SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    className="quick-prompt-chip"
                    onClick={() => void start(suggestion)}
                  >
                    ✦ {suggestion}
                  </button>
                ))}
              </div>
            )}
          </div>

          {error && <div className="notice error">{error}</div>}
          {notice && <div className="notice warn">{notice}</div>}

          {phase === 'awaiting_answers' && questions.length > 0 && (
            <div className="interview-slot">
              <InterviewPanel
                questions={questions}
                busy={false}
                onSubmit={(answers) => void answer(answers, false)}
                onSkip={() => void answer({}, true)}
              />
            </div>
          )}

          {transcriptLoading && (
            <p className="loading-line loading-line-centered">
              <span className="loading-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              Loading conversation…
            </p>
          )}

          {!transcriptLoading && showResults && (
            <>
              {askedQuestion && (
                <div className="asked-question">
                  <span className="asked-question-label">Your question</span>
                  <p>{askedQuestion}</p>
                </div>
              )}
              <AgentTabs panes={panes} complete={generationComplete} />
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'budget_exceeded') return err.message;
    if (err.code === 'no_provider') {
      return 'No AI provider is configured on the server. Set an API key in .env and restart the API.';
    }
    if (err.status === 401) return 'Your session expired. Please sign in again.';
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}
