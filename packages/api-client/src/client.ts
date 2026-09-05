import type {
  AgentKind,
  Alternative,
  AttachmentRef,
  Checkpoint,
  CompiledQuery,
  InterviewQuestion,
  InterviewState,
  ProjectArtifact,
  ProjectBlueprint,
  SkillLevel,
  SourceFile,
} from '@ai-edu/core';

import { ApiError, streamSSE } from './sse.js';

/**
 * The typed client. `apps/web` talks to the API only through this — no bare
 * `fetch` anywhere in the UI — so the future mobile app reuses the whole
 * network layer rather than reimplementing it.
 */

export interface ApiClientOptions {
  baseUrl: string;
  /** Called per request so a refreshed session token is always picked up. */
  getToken: () => string | Promise<string>;
}

/* ------------------------------------------------------------------ *
 * Response shapes
 * ------------------------------------------------------------------ */

// Re-exported because it appears in the shapes below: a UI holding a
// StepContent should not have to reach past this package for the type of the
// files inside it.
export type { SourceFile };

export type InterviewResponse =
  | { status: 'ready'; compiled: CompiledQuery; state?: InterviewState; degraded?: boolean }
  | { status: 'awaiting_answers'; questions: InterviewQuestion[]; state: InterviewState };

export interface ModelOption {
  id: string;
  label: string;
  vendor: string;
  blurb: string | null;
  contextWindow: number;
  unpriced: boolean;
}

export interface BudgetStatus {
  spentUSD: number;
  limitUSD: number;
  exceeded: boolean;
  hasUnpricedUsage: boolean;
}

/** What the UI consumes. Mirrors the server's per-agent SSE events. */
export type AgentStreamEvent =
  | {
      kind: 'meta';
      messageId: string;
      /** The conversation this answer was filed under. Null if it failed to persist. */
      threadId: string | null;
      model: string;
      agents: readonly AgentKind[];
    }
  | { kind: 'start'; agent: AgentKind }
  | { kind: 'delta'; agent: AgentKind; text: string }
  | { kind: 'done'; agent: AgentKind }
  | { kind: 'error'; agent: AgentKind; message: string }
  | { kind: 'finished'; messageId: string }
  | { kind: 'fatal'; message: string };

export interface AskOptions {
  compiled: CompiledQuery;
  threadId?: string | null;
  model?: string;
  signal?: AbortSignal;
}

/* ---- conversation history ---- */

export interface ThreadSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Questions asked in this conversation. Never zero — empty threads are filtered out. */
  messageCount: number;
}

/** One turn of a private conversation with a single specialist. */
export interface FollowUpTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Each specialist's follow-up thread, keyed by agent. Absent means none yet. */
export type FollowUpThreads = Partial<Record<AgentKind, FollowUpTurn[]>>;

/** One question and the four answers it produced, as replayed from storage. */
export interface ThreadTurn {
  messageId: string;
  question: string;
  askedAt: string;
  panes: Record<AgentKind, { status: 'complete' | 'error'; text: string; error: string | null }>;
  /** Per-specialist follow-ups on this question. */
  followups: FollowUpThreads;
}

/** What the browser consumes while one specialist answers a follow-up. */
export type FollowUpStreamEvent =
  | { kind: 'meta'; agent: AgentKind; turnIndex: number; model: string }
  | { kind: 'delta'; text: string }
  | { kind: 'done'; text: string }
  | { kind: 'error'; message: string };

export interface ThreadDetail {
  thread: Omit<ThreadSummary, 'messageCount'>;
  turns: ThreadTurn[];
}


/* ---- projects ---- */

export interface ProjectSummary {
  id: string;
  title: string;
  summary: string | null;
  tech_stack: unknown;
  skill_level: SkillLevel;
  estimated_hours: number | null;
  status: string;
  created_at: string;
}

export interface ProjectStepRef {
  id: string;
  stepIndex: number;
  title: string;
  objective: string | null;
  concepts: string[];
  estMinutes: number | null;
  /** False until Phase B has written this step. */
  expanded: boolean;
  /** True once an attempt on this step has passed. */
  passed: boolean;
  /**
   * False until the previous step passes. A locked step is still readable once
   * written — the editor and checkpoint are what close, not the instructions.
   */
  unlocked: boolean;
}

export interface ProjectDetail {
  project: Record<string, unknown> & { id: string; title: string };
  steps: ProjectStepRef[];
  currentStepIndex: number;
  /** Highest step index the learner may work on. */
  unlockedThrough: number;
  /** When the finished project was last assembled and written. Null if never. */
  artifactGeneratedAt: string | null;
}

/** A step as sent to the browser. Solution files are deliberately absent. */
export interface StepContent {
  stepIndex: number;
  title: string;
  objective: string | null;
  instructionsMd: string;
  explanationMd: string;
  alternatives: Alternative[];
  starterFiles: SourceFile[];
  /**
   * The rest of the project, as this step finds it.
   *
   * `starterFiles` is only what this step creates or edits, so on its own it
   * presents step 3 of a todo list as a lone `app.js` with no page around it.
   * These are the files earlier steps produced — the learner's own code where
   * they wrote it, the reference where they did not — and they are read-only
   * in the editor: the step that owns a file is the step that grades it.
   *
   * The checkpoint runs against both sets together. A test asserting on the
   * markup is testing the project, not the diff.
   */
  priorFiles: SourceFile[];
  checkpoint: Checkpoint;
  hintCount: number;
  /** Attempts already recorded on this step. Drives the hint gate on mount. */
  attemptCount: number;
  /** ISO timestamp of the first attempt. */
  firstAttemptAt: string | null;
  /**
   * When the learner opened this step. What the hint clock runs from.
   *
   * It used to run from the first attempt, which made the ladder's "or N
   * minutes" half unreachable for the case it exists for: a learner who cannot
   * work out how to begin has submitted nothing, so their clock had not
   * started and no hint would ever open on time.
   */
  startedAt: string | null;
  /**
   * The editor as the learner last left it, or null if they have not started.
   * What the step opens with, in place of the starter files.
   */
  draftFiles: SourceFile[] | null;
  /** True once any attempt on this step has passed. */
  passed: boolean;
  /** True once the learner has chosen to see the explanation. */
  revealed: boolean;
  /** The checkpoint panel as they last saw it, restored on reopen. */
  lastRun: CheckpointRun | null;
  /** Hint tiers already opened, reopened as they were. */
  hintsOpened: number[];
  /**
   * Why this step was reshaped, when adaptive pacing changed it.
   *
   * Null on a step the blueprint produced unchanged. Surfaced to the learner on
   * purpose: pacing that silently rewrites the work is a black box, and a
   * learner who cannot see why the difficulty moved cannot argue with it.
   */
  pacingDirective: PacingDirective | null;
}

/* ---- the project tutor ---- */

export interface TutorTranscriptTurn {
  role: 'user' | 'assistant';
  content: string;
  /** Which step it was asked on. Null when asked from the finished view. */
  stepIndex: number | null;
  /** True when this answer contained code the gate had opened. */
  revealedCode: boolean;
  at: string;
}

/** How close a step is to earning the code. Displayed, never enforced here. */
export interface TutorGate {
  unlocked: boolean;
  score: number;
  threshold: number;
  /** What is still outstanding, in the learner's words. */
  missing: string[];
}

export type TutorStreamEvent =
  | { kind: 'meta'; turnIndex: number; unlocked: boolean; missing: string[] }
  | { kind: 'delta'; text: string }
  | { kind: 'done'; text: string }
  | { kind: 'error'; message: string };

/** Whether the assembled project contains every file the blueprint planned. */
export interface CompletenessReport {
  complete: boolean;
  /** Planned files the finished project does not contain. */
  missing: string[];
  /** Files the project has that the plan never mentioned. Not a defect. */
  unplanned: string[];
}

export interface PacingDirective {
  adjustment: 'scaffold' | 'insert_micro_step' | 'hold' | 'compress' | 'stretch';
  reason: string;
  notes: string[];
}

/**
 * A finished checkpoint run, as the learner saw it.
 *
 * Stored so a revisited step shows its result instead of presenting itself as
 * never attempted.
 */
export interface CheckpointRun {
  status: 'passed' | 'failed';
  layers: Array<{ status: 'pending' | 'running' | 'passed' | 'failed'; message: string | null }>;
  /** ISO timestamp of the run. */
  at: string;
}

/** A partial update of the learner's state on one step. */
export interface StepProgressPatch {
  files?: SourceFile[];
  revealed?: boolean;
  lastRun?: CheckpointRun | null;
  hintsOpened?: number[];
  /** The learner has opened this step. Starts the hint clock, once. */
  started?: boolean;
}

export interface ExpansionPlan {
  blocking: number | null;
  background: number[];
}

export interface AttemptResult {
  passed: boolean;
  solutionFiles?: Array<{ path: string; contents: string }>;
  failedLayer?: string;
  message?: string;
}

export interface AdvanceResult {
  ok: boolean;
  nextStepIndex: number;
}

export interface HintResponse {
  tier: number;
  text: string;
}

/* ------------------------------------------------------------------ *
 * Client
 * ------------------------------------------------------------------ */

export class ApiClient {
  private readonly baseUrl: string;
  private readonly getToken: ApiClientOptions['getToken'];

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.getToken = options.getToken;
  }

  /* ---- interview ---- */

  async startInterview(input: {
    query: string;
    threadId?: string | null;
    projectId?: string | null;
    stepId?: string | null;
    attachments?: AttachmentRef[];
  }): Promise<InterviewResponse> {
    return this.post<InterviewResponse>('/api/interview/start', {
      query: input.query,
      threadId: input.threadId ?? null,
      projectId: input.projectId ?? null,
      stepId: input.stepId ?? null,
      attachments: input.attachments ?? [],
    });
  }

  async continueInterview(input: {
    state: InterviewState;
    answers: Record<string, string>;
    attachments?: AttachmentRef[];
    skip?: boolean;
  }): Promise<InterviewResponse> {
    return this.post<InterviewResponse>('/api/interview/continue', {
      state: input.state,
      answers: input.answers,
      attachments: input.attachments ?? [],
      skip: input.skip ?? false,
    });
  }

  /* ---- fan-out ---- */

  /**
   * One connection carrying all four agents. Translates the wire events into
   * the discriminated union above so the UI never parses SSE itself.
   */
  async *ask(options: AskOptions): AsyncIterable<AgentStreamEvent> {
    const token = await this.getToken();

    const stream = streamSSE({
      url: `${this.baseUrl}/api/agents/ask`,
      token,
      body: {
        compiled: options.compiled,
        threadId: options.threadId ?? null,
        ...(options.model ? { model: options.model } : {}),
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });

    for await (const message of stream) {
      const payload = safeParse(message.data);
      if (!payload) continue;

      switch (message.event) {
        case 'meta':
          yield { kind: 'meta', ...(payload as Omit<Extract<AgentStreamEvent, { kind: 'meta' }>, 'kind'>) };
          break;

        case 'agent': {
          const event = payload as { agent: AgentKind; type: string; text?: string; message?: string };
          if (event.type === 'start') yield { kind: 'start', agent: event.agent };
          else if (event.type === 'delta') yield { kind: 'delta', agent: event.agent, text: event.text ?? '' };
          else if (event.type === 'done') yield { kind: 'done', agent: event.agent };
          else if (event.type === 'error')
            yield { kind: 'error', agent: event.agent, message: event.message ?? 'Agent failed.' };
          break;
        }

        case 'done':
          yield { kind: 'finished', messageId: (payload as { messageId: string }).messageId };
          break;

        case 'fatal':
          yield { kind: 'fatal', message: (payload as { message: string }).message };
          break;
      }
    }
  }

  /* ---- projects ---- */

  /**
   * Phase A. Returns a plan WITHOUT persisting it — the learner approves or
   * discards it before anything is stored or further generation is paid for.
   */
  async generateBlueprint(input: {
    compiled: CompiledQuery;
    model?: string;
    /**
     * Spend real steps teaching deployment. Independent of whether deploy
     * CONFIG is written at the end — that happens either way.
     */
    teachDeployment?: boolean;
  }): Promise<{ blueprint: ProjectBlueprint; model: string }> {
    return this.post('/api/projects/blueprint', {
      compiled: input.compiled,
      teachDeployment: input.teachDeployment ?? false,
      ...(input.model ? { model: input.model } : {}),
    });
  }

  async createProject(input: {
    blueprint: ProjectBlueprint;
    skillLevel?: SkillLevel;
    areaOfInterest?: string | null;
    model?: string;
  }): Promise<{ id: string }> {
    return this.post('/api/projects', {
      blueprint: input.blueprint,
      skillLevel: input.skillLevel ?? 'beginner',
      areaOfInterest: input.areaOfInterest ?? null,
      ...(input.model ? { model: input.model } : {}),
    });
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const { projects } = await this.get<{ projects: ProjectSummary[] }>('/api/projects');
    return projects;
  }

  async getProject(id: string): Promise<ProjectDetail> {
    return this.get<ProjectDetail>(`/api/projects/${id}`);
  }

  /**
   * Delete a project and everything under it.
   *
   * Irreversible, and it takes the learner's own code with it: their attempts,
   * their drafts, their progress. Callers are expected to confirm first.
   */
  async deleteProject(id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' });
  }

  /**
   * Phase B. Idempotent — an already-expanded step is returned from storage.
   *
   * `regenerate` writes the step again from scratch, for when it came out
   * wrong. It costs a generation and is rate limited with the rest of them.
   * The learner's draft is untouched: it lives on the progress row, not on the
   * step, so rewriting the step cannot discard their work.
   */
  async expandStep(
    projectId: string,
    stepIndex: number,
    regenerate = false,
  ): Promise<{ step: StepContent; cached: boolean }> {
    return this.post(`/api/projects/${projectId}/steps/${stepIndex}/expand`, { regenerate });
  }

  /** What to fetch next: what blocks the learner, and what to warm in the background. */
  async getExpansionPlan(projectId: string): Promise<ExpansionPlan> {
    return this.get<ExpansionPlan>(`/api/projects/${projectId}/plan`);
  }

  /* ---- attempts & hints ---- */

  async submitAttempt(
    projectId: string,
    stepIndex: number,
    files: Array<{ path: string; contents: string }>,
    durationMs?: number,
    /**
     * Sandbox test outcomes. Only the browser can run them, so the server
     * cannot grade an attempt honestly without being told.
     */
    testResults?: Array<{ name: string; passed: boolean; message: string }>,
  ): Promise<AttemptResult> {
    return this.post<AttemptResult>(
      `/api/projects/${projectId}/steps/${stepIndex}/attempt`,
      {
        submittedFiles: files,
        ...(durationMs != null ? { durationMs } : {}),
        ...(testResults ? { testResults } : {}),
      },
    );
  }

  /**
   * Save part of the learner's state on this step.
   *
   * Partial on purpose: the editor autosaves files on a debounce while
   * revealing an explanation or opening a hint is a single immediate fact, and
   * neither should overwrite the other. Idempotent — it replaces the one
   * progress row rather than appending.
   */
  async saveProgress(
    projectId: string,
    stepIndex: number,
    patch: StepProgressPatch,
  ): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(
      `/api/projects/${projectId}/steps/${stepIndex}/progress`,
      { method: 'PUT', body: JSON.stringify(patch) },
    );
  }

  async advanceStep(projectId: string, stepIndex: number): Promise<AdvanceResult> {
    return this.post<AdvanceResult>(
      `/api/projects/${projectId}/steps/${stepIndex}/advance`,
      {},
    );
  }

  async getHint(projectId: string, stepIndex: number, tier: number): Promise<HintResponse> {
    return this.get<HintResponse>(
      `/api/projects/${projectId}/steps/${stepIndex}/hints?tier=${tier}`,
    );
  }

  /* ---- the finished project ---- */

  /**
   * Phase C. Assembles the project from the learner's own code and writes the
   * README and deployment config for it.
   *
   * Cached server-side against the assembled files, so calling this repeatedly
   * on unchanged code costs nothing. `regenerate` forces a rewrite.
   */
  /**
   * Whether the assembled project is the project that was planned.
   *
   * `missing` lists files the blueprint called for that the code does not have
   * - almost always steps the learner skipped. Reported rather than enforced:
   * they are entitled to download what they built, just not to be told it is
   * finished when it is not.
   */
  async finishProject(
    projectId: string,
    regenerate = false,
  ): Promise<{ artifact: ProjectArtifact; cached: boolean; completeness: CompletenessReport }> {
    return this.post(`/api/projects/${projectId}/finish`, { regenerate });
  }

  /**
   * The finished project as a zip.
   *
   * Returned as a Blob rather than a URL because the download is authenticated:
   * a bare href would reach the API without the bearer token and 401. The
   * caller turns it into an object URL and clicks it.
   */
  async exportProject(projectId: string): Promise<Blob> {
    const token = await this.getToken();
    const response = await fetch(`${this.baseUrl}/api/projects/${projectId}/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      throw new ApiError(
        response.status,
        typeof payload?.['error'] === 'string' ? payload['error'] : 'export_failed',
        typeof payload?.['message'] === 'string'
          ? payload['message']
          : 'Could not export this project.',
        payload,
      );
    }

    return response.blob();
  }

  /* ---- misc ---- */

  async listModels(): Promise<ModelOption[]> {
    const { models } = await this.get<{ models: ModelOption[] }>('/api/models');
    return models;
  }

  async getBudget(): Promise<BudgetStatus> {
    return this.get<BudgetStatus>('/api/budget');
  }

  /* ---- conversation history ---- */

  async listThreads(): Promise<ThreadSummary[]> {
    const { threads } = await this.get<{ threads: ThreadSummary[] }>('/api/threads');
    return threads;
  }

  async getThread(id: string): Promise<ThreadDetail> {
    return this.get<ThreadDetail>(`/api/threads/${id}`);
  }

  async renameThread(id: string, title: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/api/threads/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    });
  }

  async deleteThread(id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/api/threads/${id}`, { method: 'DELETE' });
  }

  /* ---- following up with one specialist ---- */

  /**
   * Continue with a single agent.
   *
   * One stream rather than four: the fan-out's shared-cache stagger buys
   * nothing here, and the point of this call is to press on ONE angle. The
   * specialist keeps its own instruction and is shown what its three siblings
   * said, so it can build on ground already covered instead of repeating it.
   */
  async *followUp(options: {
    messageId: string;
    agent: AgentKind;
    question: string;
    signal?: AbortSignal;
  }): AsyncIterable<FollowUpStreamEvent> {
    const token = await this.getToken();

    const stream = streamSSE({
      url: `${this.baseUrl}/api/agents/followup`,
      token,
      body: {
        messageId: options.messageId,
        agent: options.agent,
        question: options.question,
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });

    for await (const message of stream) {
      const payload = safeParse(message.data);
      if (!payload) continue;

      switch (message.event) {
        case 'meta':
          yield { kind: 'meta', ...(payload as { agent: AgentKind; turnIndex: number; model: string }) };
          break;
        case 'delta':
          yield { kind: 'delta', text: (payload as { text: string }).text };
          break;
        case 'done':
          yield { kind: 'done', text: (payload as { text: string }).text };
          break;
        case 'error':
        case 'fatal':
          yield { kind: 'error', message: (payload as { message: string }).message };
          break;
      }
    }
  }

  /* ---- the project tutor ---- */

  /**
   * Ask the tutor about the project.
   *
   * One stream, one conversation spanning the whole project. Whether the answer
   * may contain code is decided by the server from stored counters; `meta`
   * reports which mode the answer came back in and what is still outstanding if
   * it was withheld, so the panel can say "not yet, because" rather than
   * leaving the model to improvise a refusal.
   */
  async *askTutor(options: {
    projectId: string;
    stepIndex: number | null;
    message: string;
    signal?: AbortSignal;
  }): AsyncIterable<TutorStreamEvent> {
    const token = await this.getToken();

    const stream = streamSSE({
      url: `${this.baseUrl}/api/projects/${options.projectId}/tutor`,
      token,
      body: { stepIndex: options.stepIndex, message: options.message },
      ...(options.signal ? { signal: options.signal } : {}),
    });

    for await (const message of stream) {
      const payload = safeParse(message.data);
      if (!payload) continue;

      switch (message.event) {
        case 'meta':
          yield {
            kind: 'meta',
            ...(payload as { turnIndex: number; unlocked: boolean; missing: string[] }),
          };
          break;
        case 'delta':
          yield { kind: 'delta', text: (payload as { text: string }).text };
          break;
        case 'done':
          yield { kind: 'done', text: (payload as { text: string }).text };
          break;
        case 'error':
        case 'fatal':
          yield { kind: 'error', message: (payload as { message: string }).message };
          break;
      }
    }
  }

  /** The whole project's tutor transcript, oldest first. */
  async getTutorThread(projectId: string): Promise<TutorTranscriptTurn[]> {
    const { turns } = await this.get<{ turns: TutorTranscriptTurn[] }>(
      `/api/projects/${projectId}/tutor`,
    );
    return turns;
  }

  /**
   * How close this step is to earning the code.
   *
   * Advisory. The same answer is computed again from the same rows on every
   * ask, so this endpoint is what the panel displays, never what decides.
   */
  async getTutorGate(projectId: string, stepIndex: number): Promise<TutorGate> {
    return this.get<TutorGate>(`/api/projects/${projectId}/tutor/gate/${stepIndex}`);
  }

  /** Every specialist's follow-up thread on one question. */
  async getFollowUps(messageId: string): Promise<FollowUpThreads> {
    const { followups } = await this.get<{ followups: FollowUpThreads }>(
      `/api/agents/followups/${messageId}`,
    );
    return followups;
  }

  /* ---- plumbing ---- */

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const token = await this.getToken();

    /*
     * Content-Type is declared only when there is actually a body.
     *
     * Sending it on a bodyless request is not merely redundant - Fastify runs
     * its JSON parser on any request whose content-type says JSON and whose
     * method may carry a body, and an empty body then fails with
     * "Body cannot be empty when content-type is set to 'application/json'".
     * DELETE is exactly that shape, so every DELETE this client made was
     * rejected with a 400 before it reached its route.
     */
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined || init.body === null
        ? {}
        : { 'Content-Type': 'application/json' }),
      ...((init.headers ?? {}) as Record<string, string>),
    };

    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const record = (payload ?? {}) as Record<string, unknown>;
      throw new ApiError(
        response.status,
        typeof record['error'] === 'string' ? record['error'] : 'request_failed',
        typeof record['message'] === 'string' ? record['message'] : response.statusText,
        payload,
      );
    }

    return payload as T;
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' });
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: 'POST', body: JSON.stringify(body) });
  }
}

function safeParse(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
