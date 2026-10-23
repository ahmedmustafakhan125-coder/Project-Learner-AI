/**
 * What the signed-in top bar shows about a learner.
 *
 * One summary feeds every panel, so the bar costs one request rather than one
 * per panel. A section is `null` when its source failed to load — the panel
 * says so and offers a retry — and an empty list when there is genuinely
 * nothing yet. One failed source never blanks the whole bar.
 */

export interface NavThread {
  id: string;
  title: string;
  updatedAt: string;
  /** Questions asked in it. Never zero — empty threads are filtered out upstream. */
  messageCount: number;
}

export interface NavProject {
  id: string;
  title: string;
  /** `project_status`: draft, generating, active, completed or abandoned. */
  status: string;
  updatedAt: string;
  /** Zero-based step the learner is on, from the enrollment. Null when unknown. */
  currentStep: number | null;
  stepCount: number | null;
}

export interface NavInterest {
  /** `concept:<key>`. */
  nodeId: string;
  label: string;
  /** Mastery, 0..1. Null when the brain holds no score yet. */
  mastery: number | null;
  /** Conversations that reached this concept. */
  sessions: number;
  lastSeenAt: string;
  /** Concepts that came up alongside it, strongest link first. */
  related: { nodeId: string; label: string }[];
}

export type RecommendationKind =
  | 'continue_project'
  | 'assess'
  | 'strengthen'
  | 'revisit_thread'
  | 'next_project';

/** What a recommendation points at. The web maps it to a route; core knows none. */
export interface RecTarget {
  type: 'project' | 'concept' | 'thread';
  /** Project id, brain node id (`concept:<key>`), or thread id. */
  id: string;
  label: string;
}

export interface Recommendation {
  /** `<kind>:<target id>` — stable across requests, so a list can key on it. */
  id: string;
  kind: RecommendationKind;
  title: string;
  /** Why it was suggested, from a fixed template. */
  reason: string;
  target: RecTarget;
  score: number;
}

export interface NavSummary {
  workspace: { recent: NavThread[] } | null;
  projects: { built: number; learned: number; recent: NavProject[] } | null;
  brain: { interests: NavInterest[]; conceptCount: number } | null;
  recommendations: Recommendation[];
  generatedAt: string;
}
