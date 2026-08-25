'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CompiledQuery, InterviewQuestion, InterviewState, ProjectBlueprint } from '@ai-edu/core';
import { ApiError } from '@ai-edu/api-client';

import { AuthGate } from '../../../components/AuthGate';
import { InterviewPanel } from '../../../components/InterviewPanel';
import { BlueprintReview } from '../../../components/BlueprintReview';
import { api } from '../../../lib/api';

/**
 * Project intake.
 *
 *   describe it -> interview -> blueprint -> approve -> project
 *
 * The blueprint step exists so the learner sees the plan before committing.
 * Generating a whole project someone did not want is the expensive mistake this
 * flow is shaped to avoid — nothing is persisted until they approve.
 */

type Phase = 'describing' | 'interviewing' | 'awaiting_answers' | 'planning' | 'reviewing' | 'creating';

export default function NewProjectPage() {
  return (
    <AuthGate>
      <NewProject />
    </AuthGate>
  );
}

function NewProject() {
  const router = useRouter();
  const [goal, setGoal] = useState('');
  const [phase, setPhase] = useState<Phase>('describing');
  const [questions, setQuestions] = useState<InterviewQuestion[]>([]);
  const [state, setState] = useState<InterviewState | null>(null);
  const [compiled, setCompiled] = useState<CompiledQuery | null>(null);
  const [blueprint, setBlueprint] = useState<ProjectBlueprint | null>(null);
  const [error, setError] = useState<string | null>(null);

  const plan = useCallback(async (query: CompiledQuery) => {
    setPhase('planning');
    setCompiled(query);
    try {
      const { blueprint: generated } = await api.generateBlueprint({ compiled: query });
      setBlueprint(generated);
      setPhase('reviewing');
    } catch (err) {
      setError(describe(err));
      setPhase('describing');
    }
  }, []);

  const start = useCallback(async () => {
    if (!goal.trim()) return;
    setError(null);
    setPhase('interviewing');

    try {
      const result = await api.startInterview({ query: goal });
      if (result.status === 'awaiting_answers') {
        setQuestions(result.questions);
        setState(result.state);
        setPhase('awaiting_answers');
        return;
      }
      await plan(result.compiled);
    } catch (err) {
      setError(describe(err));
      setPhase('describing');
    }
  }, [goal, plan]);

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
        await plan(result.compiled);
      } catch (err) {
        setError(describe(err));
        setPhase('awaiting_answers');
      }
    },
    [state, plan],
  );

  const accept = useCallback(async () => {
    if (!blueprint) return;
    setPhase('creating');
    try {
      const skill = compiled?.slots['skill_level']?.value;
      const { id } = await api.createProject({
        blueprint,
        skillLevel: isSkill(skill) ? skill : 'beginner',
        areaOfInterest: compiled?.slots['domain']?.value ?? null,
      });
      router.push(`/projects/${id}`);
    } catch (err) {
      setError(describe(err));
      setPhase('reviewing');
    }
  }, [blueprint, compiled, router]);

  const regenerate = useCallback(() => {
    if (compiled) void plan(compiled);
  }, [compiled, plan]);

  const busy = phase === 'interviewing' || phase === 'planning' || phase === 'creating';

  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <h1>Start a project</h1>
          <div className="sub">Describe what you want to build. You will approve the plan before anything is generated.</div>
        </div>
      </header>

      {phase === 'describing' && (
        <div className="querybox">
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="What do you want to build, and what do you want to get better at?"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void start();
            }}
          />
          <div className="row">
            <span className="muted">Ctrl/⌘ + Enter to continue</span>
            <button className="btn primary" onClick={() => void start()} disabled={!goal.trim()}>
              Continue
            </button>
          </div>
        </div>
      )}

      {error && <div className="notice error">{error}</div>}

      {phase === 'awaiting_answers' && questions.length > 0 && (
        <InterviewPanel
          questions={questions}
          busy={false}
          onSubmit={(answers) => void answer(answers, false)}
          onSkip={() => void answer({}, true)}
        />
      )}

      {phase === 'interviewing' && <p className="skeleton">Reading your goal…</p>}

      {phase === 'planning' && (
        <div className="notice info">
          Designing your project. This one takes a little longer — it is planning every step.
        </div>
      )}

      {(phase === 'reviewing' || phase === 'creating') && blueprint && (
        <BlueprintReview
          blueprint={blueprint}
          busy={busy}
          onAccept={() => void accept()}
          onRegenerate={regenerate}
        />
      )}
    </main>
  );
}

function isSkill(value: unknown): value is 'beginner' | 'intermediate' | 'advanced' {
  return value === 'beginner' || value === 'intermediate' || value === 'advanced';
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'budget_exceeded') return err.message;
    if (err.code === 'no_provider') {
      return 'No AI provider is configured on the server. Set an API key in .env and restart the API.';
    }
    if (err.code === 'generation_failed') {
      return `${err.message} You can try again — planning is not deterministic.`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}
