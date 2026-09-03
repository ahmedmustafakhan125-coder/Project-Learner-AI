'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CompiledQuery, InterviewQuestion, InterviewState } from '@ai-edu/core';
import { ApiError, type ModelOption } from '@ai-edu/api-client';

import { AgentTabs, type AgentPanes, emptyPanes } from '../../components/AgentTabs';
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

  // Abort any in-flight fan-out when the page unmounts. Without this the
  // server keeps generating four answers nobody will ever read.
  useEffect(() => () => abortRef.current?.abort(), []);

  const runFanOut = useCallback(async (compiled: CompiledQuery) => {
    setPhase('streaming');
    setPanes(emptyPanes());

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    try {
      for await (const event of api.ask({
        compiled,
        ...(model ? { model } : {}),
        signal: controller.signal,
      })) {
        switch (event.kind) {
          case 'start':
            setPanes((prev) => ({ ...prev, [event.agent]: { ...prev[event.agent], status: 'streaming' } }));
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
            setPanes((prev) => ({ ...prev, [event.agent]: { ...prev[event.agent], status: 'complete' } }));
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
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(describe(err));
      setPhase('idle');
    }
  }, [model]);

  const start = useCallback(async (customQuery?: string) => {
    const promptToUse = (customQuery ?? query).trim();
    if (!promptToUse) return;
    if (customQuery) setQuery(customQuery);
    
    setError(null);
    setNotice(null);
    setQuestions([]);
    setState(null);
    setPhase('interviewing');

    try {
      const result = await api.startInterview({ query: promptToUse });

      if (result.status === 'awaiting_answers') {
        setQuestions(result.questions);
        setState(result.state);
        setPhase('awaiting_answers');
        return;
      }

      if ('degraded' in result && result.degraded) {
        setNotice('Could not gather context, so this answer is based on your question alone.');
      }
      await runFanOut(result.compiled);
    } catch (err) {
      setError(describe(err));
      setPhase('idle');
    }
  }, [query, runFanOut]);

  const answer = useCallback(
    async (answers: Record<string, string>, skip: boolean) => {
      if (!state) return;
      setPhase('interviewing');

      try {
        const result = await api.continueInterview({ state, answers, skip });

        if (result.status === 'awaiting_answers') {
          setQuestions(result.questions);
          setState(result.state);
          setPhase('awaiting_answers');
          return;
        }

        setQuestions([]);
        await runFanOut(result.compiled);
      } catch (err) {
        setError(describe(err));
        setPhase('awaiting_answers');
      }
    },
    [state, runFanOut],
  );

  const busy = phase === 'interviewing' || phase === 'streaming';

  return (
    <main className="shell">
      <header className="masthead">
        <h1>What shall we explore today?</h1>
        <div className="sub">
          Ask any programming or architecture problem. Four dedicated specialist agents reason and stream answers in parallel.
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {models.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="muted" style={{ fontSize: '12px' }}>AI Model:</span>
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
                </div>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span className="muted" style={{ fontSize: '12px' }}>
                <kbd style={{ background: 'var(--surface-2)', padding: '2px 8px', borderRadius: '4px', border: '1px solid var(--border)', color: 'var(--text)' }}>
                  Ctrl/⌘ + Enter
                </kbd>
              </span>
              <button
                className="btn primary"
                onClick={() => void start()}
                disabled={busy || !query.trim()}
              >
                {phase === 'interviewing' ? 'Analyzing…' : phase === 'streaming' ? 'Streaming 4 Agents…' : 'Run Query'}
              </button>
            </div>
          </div>
        </div>

        {phase === 'idle' && (
          <div style={{ marginTop: '20px', textAlign: 'center' }}>
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
          </div>
        )}
      </div>

      {error && <div className="notice error">{error}</div>}
      {notice && <div className="notice warn">{notice}</div>}

      {phase === 'awaiting_answers' && questions.length > 0 && (
        <div style={{ maxWidth: '860px', margin: '0 auto' }}>
          <InterviewPanel
            questions={questions}
            busy={false}
            onSubmit={(answers) => void answer(answers, false)}
            onSkip={() => void answer({}, true)}
          />
        </div>
      )}

      {(phase === 'streaming' || phase === 'done') && <AgentTabs panes={panes} />}
    </main>
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
