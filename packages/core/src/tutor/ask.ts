import { withRetry } from '@ai-edu/llm';
import type { LLMEvent, LLMMessage, LLMProvider, LLMUsage } from '@ai-edu/llm';

import type { AbortSignalLike } from '../platform.js';
import type { SourceFile } from '../schemas/step.js';
import { TUTOR_CORE, tutorModeInstruction, type TutorMode } from './prompts.js';

/**
 * Asking the project tutor something.
 *
 * One stream, one model, one conversation that spans the whole project. The
 * fan-out's four-angle shape is deliberately not reused here: that exists for
 * "explain this idea", where four readings genuinely help, and this is "why is
 * my code not working", where four answers to one bug is noise.
 *
 * Message order is chosen for the cache. The project and the learner's code are
 * identical on every turn until they edit something, so they sit in their own
 * block ahead of the conversation and are re-read rather than re-paid for. The
 * turns grow after that boundary.
 */

export interface TutorTurn {
  role: 'user' | 'assistant';
  content: string;
  /** Which step it was asked on, so the transcript can show where it happened. */
  stepIndex?: number;
}

export interface TutorProjectContext {
  projectTitle: string;
  projectSummary: string;
  skillLevel: string;
  techStack: string[];
  /** Every step's title, so the tutor knows what is coming and what is done. */
  stepTitles: string[];
}

export interface TutorStepContext {
  stepIndex: number;
  title: string;
  objective: string | null;
  instructionsMd: string;
  /** What the checkpoint demands. The tutor should not contradict the grader. */
  requiredFiles: string[];
  requiredSymbols: string[];
  /** The last failing run, when there is one. The most useful thing in here. */
  lastFailure: string | null;
  /** Hint text the learner has already opened. Saying it again wastes a turn. */
  hintsAlreadySeen: string[];
  /**
   * The reference solution for this step.
   *
   * Present ONLY in unlocked mode. This is not a matter of the prompt asking
   * nicely — the server builds a different context, and in locked mode this
   * field is absent, so no amount of persuasion can extract what was never
   * sent.
   */
  solutionFiles?: SourceFile[];
}

export interface AskTutorOptions {
  provider: LLMProvider;
  mode: TutorMode;
  project: TutorProjectContext;
  step: TutorStepContext;
  /** The project as it stands: their code, plus the files earlier steps left. */
  files: readonly SourceFile[];
  /** The conversation so far, oldest first, already trimmed by the caller. */
  history: readonly TutorTurn[];
  /** What they are asking now. */
  message: string;
  /** What the gate still wants, so a refusal can say "not yet, because". */
  stillMissing?: readonly string[];
  signal?: AbortSignalLike;
}

/** Enough for a real explanation with an example, not enough for an essay. */
const MAX_TOKENS = 2_000;

/**
 * A file is capped before it goes in.
 *
 * A learner can paste a 3,000-line vendored file into their project, and one
 * such file would otherwise crowd out every other file plus the conversation.
 * The cut is marked so the model knows it is reading an excerpt rather than a
 * file that mysteriously ends mid-function.
 */
const FILE_EXCERPT_CHARS = 6_000;

function renderFile(file: SourceFile): string {
  const truncated = file.contents.length > FILE_EXCERPT_CHARS;
  const body = truncated ? file.contents.slice(0, FILE_EXCERPT_CHARS) : file.contents;
  return [
    `<file path="${file.path}">`,
    body,
    truncated ? '\n… truncated; this file is longer than shown.' : '',
    '</file>',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The project and the step: stable across a conversation, so cached as one block. */
export function renderTutorContext(options: AskTutorOptions): string {
  const { project, step, files } = options;

  const lines = [
    '<project>',
    `Title: ${project.projectTitle}`,
    `Summary: ${project.projectSummary}`,
    `Learner level: ${project.skillLevel}`,
    project.techStack.length ? `Stack: ${project.techStack.join(', ')}` : '',
    '',
    'Steps:',
    ...project.stepTitles.map((title, i) => {
      const marker = i === step.stepIndex ? ' <- they are here' : '';
      return `  ${i + 1}. ${title}${marker}`;
    }),
    '</project>',
    '',
    `<current_step index="${step.stepIndex + 1}">`,
    `Title: ${step.title}`,
    step.objective ? `Objective: ${step.objective}` : '',
    '',
    'What the step asks them to do:',
    step.instructionsMd,
    '',
    step.requiredFiles.length
      ? `The checkpoint requires these files: ${step.requiredFiles.join(', ')}`
      : '',
    step.requiredSymbols.length
      ? `The checkpoint greps for these symbols, exactly: ${step.requiredSymbols.join(', ')}`
      : '',
    '</current_step>',
  ];

  if (step.lastFailure) {
    lines.push(
      '',
      '<last_checkpoint_failure>',
      step.lastFailure,
      '</last_checkpoint_failure>',
    );
  }

  if (step.hintsAlreadySeen.length > 0) {
    lines.push(
      '',
      '<hints_they_have_already_read>',
      // Repeating a hint they have open on screen wastes the turn and reads as
      // not having looked.
      ...step.hintsAlreadySeen.map((hint) => `- ${hint}`),
      '</hints_they_have_already_read>',
    );
  }

  lines.push(
    '',
    '<learner_code>',
    files.length === 0
      ? 'They have not written anything in this project yet.'
      : files.map(renderFile).join('\n'),
    '</learner_code>',
  );

  /*
   * Only ever reached in unlocked mode, because the server does not put
   * `solutionFiles` on the step context otherwise. Written as a conditional
   * rather than as a mode check so that the absence of the data, not the
   * correctness of a branch, is what keeps it out.
   */
  if (step.solutionFiles && step.solutionFiles.length > 0) {
    lines.push(
      '',
      '<reference_solution>',
      'One correct way to finish this step. The learner has earned the code, but write',
      'yours against THEIR structure and names — this is grounding, not something to paste.',
      ...step.solutionFiles.map(renderFile),
      '</reference_solution>',
    );
  }

  return lines.filter((line) => line !== '').join('\n');
}

export function buildTutorRequest(options: AskTutorOptions) {
  const { provider, mode, history, message, stillMissing = [] } = options;

  const messages: LLMMessage[] = [
    {
      role: 'user',
      content: [
        // Stable for the whole conversation while the code is unchanged, so a
        // long thread re-reads this rather than re-paying for it every turn.
        { type: 'text', text: renderTutorContext(options), cacheBoundary: true },
      ],
    },
  ];

  for (const turn of history) {
    messages.push({ role: turn.role, content: [{ type: 'text', text: turn.content }] });
  }

  const now = [`<learner_message>`, message, `</learner_message>`];

  /*
   * The gate's own words, handed to the model rather than described.
   *
   * Without this the model has to invent what "not yet" means, and what it
   * invents is either vague or wrong. With it, a refusal can be specific and
   * true: two more attempts and an unopened hint.
   */
  if (mode === 'locked' && stillMissing.length > 0) {
    now.push(
      '',
      '<still_needed_before_code>',
      'If they ask for the code, this is what the platform is still waiting for:',
      ...stillMissing.map((item) => `- ${item}`),
      '</still_needed_before_code>',
    );
  }

  messages.push({ role: 'user', content: [{ type: 'text', text: now.join('\n') }] });

  return {
    model: provider.modelId,
    maxTokens: MAX_TOKENS,
    system: [
      // The cached prefix. Byte-identical in both modes; the mode instruction
      // is a separate, trailing block so it cannot disturb the match.
      { text: TUTOR_CORE, cacheBoundary: true },
      { text: tutorModeInstruction(mode) },
    ],
    messages,
  };
}

/* ------------------------------------------------------------------ *
 * Streaming
 * ------------------------------------------------------------------ */

export type TutorEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; text: string; usage: LLMUsage; latencyMs: number }
  | { type: 'error'; message: string; retryable: boolean };

/**
 * Stream one answer.
 *
 * Retried only while nothing has been shown, exactly as the fan-out is: once a
 * delta has reached the browser, a second attempt would replay text on screen
 * rather than replace it.
 */
export async function* askTutor(options: AskTutorOptions): AsyncIterable<TutorEvent> {
  const { provider, signal } = options;
  const started = Date.now();

  const queue: TutorEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;

  const drainWaiter = (): void => {
    const w: (() => void) | null = wake;
    wake = null;
    w?.();
  };

  const emit = (event: TutorEvent): void => {
    queue.push(event);
    drainWaiter();
  };

  let text = '';
  let emittedDelta = false;

  const run = (async () => {
    try {
      await withRetry(
        async () => {
          text = '';
          const request = buildTutorRequest(options);
          const events: AsyncIterable<LLMEvent> = provider.stream({
            ...request,
            ...(signal ? { signal } : {}),
          });

          for await (const event of events) {
            if (event.type === 'text_delta') {
              text += event.text;
              emittedDelta = true;
              emit({ type: 'delta', text: event.text });
            } else if (event.type === 'done') {
              emit({
                type: 'done',
                text,
                usage: event.response.usage,
                latencyMs: Date.now() - started,
              });
            }
          }
        },
        { shouldRetry: () => !emittedDelta, maxRetries: 2, baseDelayMs: 250 },
      );
    } catch (err) {
      emit({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
        retryable: Boolean((err as { retryable?: boolean })?.retryable),
      });
    } finally {
      finished = true;
      drainWaiter();
    }
  })();

  while (!finished || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      continue;
    }
    yield queue.shift()!;
  }

  await run;
}
