'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { CompiledQuery, InterviewQuestion, InterviewState, ProjectBlueprint } from '@ai-edu/core';
import { ApiError, type IntakeBrief, type IntakeScope, type RecalledItem } from '@ai-edu/api-client';

import { AuthGate } from '../../../components/AuthGate';
import { InterviewPanel } from '../../../components/InterviewPanel';
import { BlueprintReview } from '../../../components/BlueprintReview';
import { IntakeProgress } from '../../../components/IntakeProgress';
import { ProjectQuestions } from '../../../components/ProjectQuestions';
import { StackBriefView } from '../../../components/StackBriefView';
import { RecallChips } from '../../../components/brain/RecallChips';
import { api } from '../../../lib/api';
import { progressSteps, type StepId } from '../../../lib/intakeProgress';

/**
 * Project intake.
 *
 *   describe it -> interview -> blueprint -> approve -> project
 *
 * The blueprint step exists so the learner sees the plan before committing.
 * Generating a whole project someone did not want is the expensive mistake this
 * flow is shaped to avoid — nothing is persisted until they approve.
 *
 * With Project Learner on (the server says so at /api/features), the questions
 * are the project ones, written by the server in code (`ProjectQuestions`).
 * After them the page carries on by itself under one progress card: intake
 * scores the project, a bigger one gets a few more questions, then research
 * and the Stack Brief run, with Try again beside a step that fails. The tier
 * is never shown; the learner's next decision is approving the brief. Every
 * stage reads what came before from the server's intake row; this page holds
 * only its id.
 */

type Phase =
  | 'describing'
  | 'interviewing'
  | 'awaiting_answers'
  | 'scoping'
  | 'refining'
  | 'researching'
  | 'briefing'
  | 'stalled'
  | 'briefed'
  | 'planning'
  | 'reviewing'
  | 'creating';

/** The phases the progress card shows, and the step each one is on. */
const PROGRESS: Partial<Record<Phase, StepId>> = {
  scoping: 'scope',
  refining: 'questions',
  researching: 'research',
  briefing: 'brief',
};

/** How long each line under the running step stays up. */
const STAGE_MS = 6_000;

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
  /** What the brain told the planner about this learner — shown beside the plan it shaped. */
  const [recalled, setRecalled] = useState<RecalledItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  /**
   * Whether the plan should spend steps teaching deployment.
   *
   * Separate from whether the finished project GETS deploy config — it always
   * does. This only buys steps in the curriculum, which is why it is off by
   * default: most people want the project, not the ops lesson.
   */
  const [teachDeployment, setTeachDeployment] = useState(false);

  /* Project Learner: off until the server says otherwise, so a failed check changes nothing. */
  const [learner, setLearner] = useState(false);
  const [intakeId, setIntakeId] = useState<string | null>(null);
  const [scope, setScope] = useState<IntakeScope | null>(null);
  /** Round 2: asked only when intake finds a project big enough for it. */
  const [moreQuestions, setMoreQuestions] = useState<InterviewQuestion[]>([]);
  const [savingAnswers, setSavingAnswers] = useState(false);
  /** The step that failed, while the card offers Try again. */
  const [failedAt, setFailedAt] = useState<StepId | null>(null);
  const [brief, setBrief] = useState<IntakeBrief | null>(null);
  const [planWarnings, setPlanWarnings] = useState<string[]>([]);
  const [planRegenerations, setPlanRegenerations] = useState(2);
  const [stage, setStage] = useState(0);

  useEffect(() => {
    let live = true;
    api
      .getFeatures()
      .then((features) => live && setLearner(features.projectLearner))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  // One line at a time under the running step, while research and the brief run.
  useEffect(() => {
    if (phase !== 'researching' && phase !== 'briefing') return;
    setStage(0);
    const timer = setInterval(() => setStage((s) => s + 1), STAGE_MS);
    return () => clearInterval(timer);
  }, [phase]);

  const plan = useCallback(
    async (query: CompiledQuery) => {
      setPhase('planning');
      setCompiled(query);
      try {
        const { blueprint: generated, recalled: used } = await api.generateBlueprint({
          compiled: query,
          teachDeployment,
        });
        setBlueprint(generated);
        setRecalled(used ?? []);
        setPhase('reviewing');
      } catch (err) {
        setError(describe(err));
        setPhase('describing');
      }
    },
    [teachDeployment],
  );

  /**
   * Research, then the brief. A failure before any brief stops on the card
   * with Try again; one while regenerating goes back to the brief it had.
   */
  const researchAndBrief = useCallback(async (id: string, hadBrief: boolean) => {
    setError(null);
    setFailedAt(null);
    setPhase('researching');
    let step: StepId = 'research';
    try {
      await api.researchIntake(id);
      step = 'brief';
      setPhase('briefing');
      setBrief(await api.generateStackBrief(id));
      setPhase('briefed');
    } catch (err) {
      setError(describe(err));
      if (hadBrief) {
        setPhase('briefed');
        return;
      }
      setFailedAt(step);
      setPhase('stalled');
    }
  }, []);

  /** Profile and tier, scored by code; then round 2 if the project needs it, or straight on. */
  const startIntake = useCallback(
    async (query: CompiledQuery) => {
      setPhase('scoping');
      setCompiled(query);
      setMoreQuestions([]);
      try {
        const { intakeId: id, questions: more, ...scoped } = await api.createIntake(query);
        setIntakeId(id);
        setScope(scoped);
        if (more.length) {
          setMoreQuestions(more);
          setPhase('refining');
          return;
        }
        await researchAndBrief(id, false);
      } catch (err) {
        setError(describe(err));
        setPhase('describing');
      }
    },
    [researchAndBrief],
  );

  const ready = useCallback(
    (query: CompiledQuery) => (learner ? startIntake(query) : plan(query)),
    [learner, plan, startIntake],
  );

  /** Round 2's answers, or none on Skip; the tier is scored again on the server. */
  const refine = useCallback(
    async (answers: Record<string, string>) => {
      if (!intakeId) return;
      setError(null);
      if (Object.keys(answers).length) {
        setSavingAnswers(true);
        try {
          setScope(await api.answerIntake(intakeId, answers));
        } catch (err) {
          setError(describe(err));
          return;
        } finally {
          setSavingAnswers(false);
        }
      }
      await researchAndBrief(intakeId, false);
    },
    [intakeId, researchAndBrief],
  );

  const planIntake = useCallback(async () => {
    if (!intakeId) return;
    setError(null);
    setPhase('planning');
    try {
      const planned = await api.generateIntakeBlueprint(intakeId, { teachDeployment });
      setBlueprint(planned.blueprint);
      setRecalled(planned.recalled ?? []);
      setPlanWarnings(planned.warnings);
      setPlanRegenerations(planned.regenerationsLeft);
      setPhase('reviewing');
    } catch (err) {
      setError(describe(err));
      setPhase(blueprint ? 'reviewing' : 'briefed');
    }
  }, [intakeId, teachDeployment, blueprint]);

  const approveBrief = useCallback(async () => {
    if (!intakeId) return;
    setError(null);
    try {
      await api.approveStackBrief(intakeId);
      await planIntake();
    } catch (err) {
      setError(describe(err));
    }
  }, [intakeId, planIntake]);

  const start = useCallback(async () => {
    if (!goal.trim()) return;
    setError(null);
    setPhase('interviewing');

    try {
      const result = await api.startInterview({ query: goal, ...(learner ? { purpose: 'project' as const } : {}) });
      if (result.status === 'awaiting_answers') {
        setQuestions(result.questions);
        setState(result.state);
        setPhase('awaiting_answers');
        return;
      }
      await ready(result.compiled);
    } catch (err) {
      setError(describe(err));
      setPhase('describing');
    }
  }, [goal, ready, learner]);

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
        await ready(result.compiled);
      } catch (err) {
        setError(describe(err));
        setPhase('awaiting_answers');
      }
    },
    [state, ready],
  );

  const accept = useCallback(async () => {
    if (!blueprint) return;
    setPhase('creating');
    try {
      if (learner && intakeId) {
        // The server builds the project from its own intake row; only the id goes.
        const { id } = await api.createProjectFromIntake(intakeId);
        router.push(`/projects/${id}`);
        return;
      }
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
  }, [blueprint, compiled, router, learner, intakeId]);

  const regenerate = useCallback(() => {
    if (learner && intakeId) void planIntake();
    else if (compiled) void plan(compiled);
  }, [compiled, plan, learner, intakeId, planIntake]);

  const busy = phase === 'interviewing' || phase === 'planning' || phase === 'creating' || phase === 'researching' || phase === 'briefing';
  const current = phase === 'stalled' ? failedAt : PROGRESS[phase];
  const steps = current
    ? progressSteps({
        current,
        failed: phase === 'stalled',
        askedMore: moreQuestions.length > 0,
        adapted: scope?.adapted ?? false,
        tier: scope?.tier ?? null,
        tick: stage,
      })
    : [];

  return (
    <main className="shell">
      {/*
        The only route into this page is the library, and until now there was no
        route back out of it: a learner who changed their mind mid-blueprint had
        the browser's back button or nothing. Nothing here is persisted until
        they approve the plan, so leaving costs them nothing and needs no
        confirmation.
      */}
      <Link href="/projects" className="page-back">
        <span aria-hidden="true">←</span> Back to library
      </Link>

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
            <label className="deploy-toggle">
              <input
                type="checkbox"
                checked={teachDeployment}
                onChange={(e) => setTeachDeployment(e.target.checked)}
              />
              <span>
                <strong>Teach me to deploy it</strong>
                <span className="deploy-toggle-hint">
                  Adds steps that ship the finished project. The deploy config is written for
                  you either way.
                </span>
              </span>
            </label>
            <button className="btn primary" onClick={() => void start()} disabled={!goal.trim()}>
              Continue
            </button>
          </div>
          <p className="muted kbd-row">Ctrl/⌘ + Enter to continue</p>
        </div>
      )}

      {/* A failed step shows its error on the progress card, beside Try again. */}
      {error && phase !== 'stalled' && <div className="notice error">{error}</div>}

      {phase === 'awaiting_answers' && questions.length > 0 && (learner ? (
        <ProjectQuestions
          questions={questions}
          busy={false}
          onSubmit={(answers) => void answer(answers, false)}
          onSkip={() => void answer({}, true)}
        />
      ) : (
        <InterviewPanel
          questions={questions}
          busy={false}
          onSubmit={(answers) => void answer(answers, false)}
          onSkip={() => void answer({}, true)}
        />
      ))}

      {phase === 'interviewing' && <p className="skeleton">Reading your goal…</p>}

      {steps.length > 0 && (
        <IntakeProgress
          steps={steps}
          error={error}
          onRetry={intakeId ? () => void researchAndBrief(intakeId, false) : undefined}
        />
      )}

      {phase === 'refining' && moreQuestions.length > 0 && (
        <ProjectQuestions
          questions={moreQuestions}
          busy={savingAnswers}
          heading="A few more questions"
          lede="This project has more moving parts, so a little more detail helps plan the right pieces. Skip any you are not sure about."
          onSubmit={(answers) => void refine(answers)}
          onSkip={() => void refine({})}
        />
      )}

      {/* Nothing is cut silently (§5): a project bigger than the time given says so. */}
      {learner && scope?.overTime && ['refining', 'researching', 'briefing', 'briefed'].includes(phase) && (
        <div className="notice warn">
          This kind of project needs more time than you have. The plan builds its first milestone as a project of
          its own, and the rest follow.
        </div>
      )}

      {phase === 'briefed' && brief && (
        <StackBriefView
          brief={brief.brief}
          sources={brief.sources}
          limitedSources={brief.limitedSources}
          reused={brief.reused}
          regenerationsLeft={brief.regenerationsLeft}
          busy={busy}
          onApprove={() => void approveBrief()}
          onRegenerate={() => {
            if (intakeId) void researchAndBrief(intakeId, true);
          }}
        />
      )}

      {phase === 'planning' && (
        <div className="notice info">
          Designing your project — the whole file tree and which step builds each part. This one
          takes a little longer, because everything after it is held to this plan.
        </div>
      )}

      {(phase === 'reviewing' || phase === 'creating') && blueprint && recalled.length > 0 && (
        <RecallChips items={recalled} heading="Pitched at you using your brain" />
      )}

      {(phase === 'reviewing' || phase === 'creating') && planWarnings.length > 0 && (
        <div className="notice warn">
          <strong>Worth knowing about this plan:</strong>
          <ul className="tight">
            {planWarnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {(phase === 'reviewing' || phase === 'creating') && blueprint && (
        <BlueprintReview
          blueprint={blueprint}
          busy={busy}
          onAccept={() => void accept()}
          onRegenerate={regenerate}
          canRegenerate={!learner || planRegenerations > 0}
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
    if (err.code === 'budget_exceeded' || err.code === 'project_budget_exceeded') return err.message;
    if (err.code === 'no_provider') {
      return 'No AI provider is configured on the server. Set an API key in .env and restart the API.';
    }
    if (err.code === 'project_generation_unavailable') {
      return 'Project generation is unavailable right now. Your progress is kept; try again later.';
    }
    // The server's message already says to try again; the plan's own failures do not.
    if (err.code === 'generation_failed' && !/try again/i.test(err.message)) {
      return `${err.message} You can try again — planning is not deterministic.`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}
