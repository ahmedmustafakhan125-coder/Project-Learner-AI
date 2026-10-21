'use client';

import Link from 'next/link';
import type { BrainNodeDetail } from '@ai-edu/api-client';
import type { RecurringMistake, SessionRef } from '@ai-edu/core';

/**
 * What one node means, in words: where it came up, what it connects to, and
 * for a concept, how well it is held and every time it was tested.
 */

interface NodeDetailPanelProps {
  detail: BrainNodeDetail | null;
  loading: boolean;
  error: string | null;
  /** Shown when nothing is selected: the patterns most worth attention. */
  mistakes: RecurringMistake[];
  /** Concepts whose retake has opened, shown with nothing selected. */
  retakes?: Array<{ conceptKey: string; label: string }>;
  /**
   * Start (or resume) a test on a concept. Absent while replaying the past —
   * a test is always of the learner as they are now.
   */
  onTestMe?: (conceptKey: string) => void;
  /** Feedback from the last "Test me": a running start, or why it could not. */
  testState?: { busy: boolean; message: string | null };
  onSelect: (id: string) => void;
  onFocus: (id: string) => void;
  onClose: () => void;
}

const KIND_LABEL: Record<BrainNodeDetail['node']['kind'], string> = {
  concept: 'Concept',
  insight: 'Takeaway',
  mistake: 'Mistake',
  session: 'Session',
  project: 'Project',
  checkpoint: 'Checkpoint',
};

function shortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Where a session can be revisited. Assessments get a page in a later phase. */
function hrefFor(session: Pick<SessionRef, 'source' | 'sourceId'>): string | null {
  if (session.source === 'thread') return `/ask?thread=${encodeURIComponent(session.sourceId)}`;
  if (session.source === 'project') return `/projects/${encodeURIComponent(session.sourceId)}`;
  return null;
}

function confidenceWord(confidence: number | null): string {
  if (confidence === null) return 'no evidence yet';
  if (confidence < 0.3) return 'little evidence so far';
  if (confidence < 0.7) return 'some evidence';
  return 'well evidenced';
}

export function NodeDetailPanel({
  detail,
  loading,
  error,
  mistakes,
  retakes = [],
  onTestMe,
  testState,
  onSelect,
  onFocus,
  onClose,
}: NodeDetailPanelProps) {
  if (!detail && !loading && !error) {
    return (
      <aside className="brain-panel" aria-live="polite">
        {onTestMe && retakes.length > 0 && (
          <section className="brain-overview">
            <h2 className="brain-panel-title">Ready for a retake</h2>
            <ul className="brain-list brain-retakes">
              {retakes.map((r) => (
                <li key={r.conceptKey}>
                  {r.label}{' '}
                  <button
                    type="button"
                    className="linklike"
                    onClick={() => onTestMe(r.conceptKey)}
                    disabled={testState?.busy}
                  >
                    Retake
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {mistakes.length > 0 && (
          <section className="brain-overview">
            <h2 className="brain-panel-title">Mistakes that keep coming back</h2>
            <p className="muted">
              The same slip made more than once is worth more attention than any new topic. Click one to see where it
              happened.
            </p>
            <ul className="brain-list brain-mistakes">
              {mistakes.map((mistake) => (
                <li key={mistake.id}>
                  <button type="button" className="brain-link" onClick={() => onSelect(mistake.id)}>
                    {mistake.label}
                  </button>
                  <span className="brain-count">×{mistake.occurrences}</span>
                  {mistake.sessions > 1 && <span className="muted"> · in {mistake.sessions} sessions</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
        <p className="muted brain-panel-hint">
          Click any dot to see what it is, where it came from, and what it connects to. Click a conversation to watch the
          path it took through your concepts.
        </p>
      </aside>
    );
  }

  return (
    <aside className="brain-panel" aria-live="polite" aria-busy={loading}>
      <div className="brain-panel-head">
        <span className="brain-kind">{detail ? KIND_LABEL[detail.node.kind] : ' '}</span>
        <button type="button" className="brain-panel-close" onClick={onClose} aria-label="Close details">
          ×
        </button>
      </div>

      {error && <div className="notice error">{error}</div>}
      {loading && !detail && <p className="skeleton">Loading…</p>}

      {detail && (
        <>
          <h2 className="brain-panel-title">{detail.node.label}</h2>
          <p className="muted brain-panel-dates">
            First seen {shortDate(detail.node.firstSeenAt)} · last {shortDate(detail.node.lastSeenAt)}
          </p>

          {detail.node.kind === 'concept' && <ConceptSummary detail={detail} />}

          {detail.node.kind === 'concept' && onTestMe && (
            <div className="brain-testme">
              <button
                type="button"
                className="btn primary"
                onClick={() => onTestMe(detail.node.key)}
                disabled={testState?.busy}
              >
                {testState?.busy ? 'Writing your test…' : 'Test me on this'}
              </button>
              {testState?.message && <p className="brain-testme-note">{testState.message}</p>}
            </div>
          )}

          {(detail.node.kind === 'session' || detail.node.kind === 'project') && <SessionSummary detail={detail} onSelect={onSelect} />}

          {detail.node.kind === 'mistake' && <MistakeSummary detail={detail} />}

          {detail.sessions.length > 0 && detail.node.kind !== 'session' && (
            <section>
              <h3>Came up in</h3>
              <ul className="brain-list">
                {detail.sessions.map((session) => {
                  const href = hrefFor(session);
                  return (
                    <li key={session.id}>
                      <button type="button" className="brain-link" onClick={() => onSelect(session.id)}>
                        {session.label}
                      </button>
                      <span className="muted"> · {shortDate(session.lastSeenAt)}</span>
                      {href && (
                        <Link className="brain-open" href={href}>
                          Open
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {detail.concepts.length > 0 && detail.node.kind !== 'session' && detail.node.kind !== 'project' && (
            <section>
              <h3>Connected concepts</h3>
              <div className="brain-chips">
                {detail.concepts.map((concept) => (
                  <button key={concept.id} type="button" className="chip" onClick={() => onSelect(concept.id)}>
                    {concept.label}
                  </button>
                ))}
              </div>
            </section>
          )}

          {detail.insights.length > 0 && (
            <section>
              <h3>Takeaways</h3>
              <ul className="brain-list brain-insights">
                {detail.insights.map((insight) => (
                  <li key={insight.id}>{insight.label}</li>
                ))}
              </ul>
            </section>
          )}

          {detail.mistakes.length > 0 && (
            <section>
              <h3>Mistakes to watch</h3>
              <ul className="brain-list brain-mistakes">
                {detail.mistakes.map((mistake) => (
                  <li key={mistake.id}>
                    <button type="button" className="brain-link" onClick={() => onSelect(mistake.id)}>
                      {mistake.label}
                    </button>
                    {mistake.occurrences > 1 && <span className="brain-count">×{mistake.occurrences}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="brain-panel-actions">
            <button type="button" className="btn" onClick={() => onFocus(detail.node.id)}>
              Focus here
            </button>
          </div>
        </>
      )}
    </aside>
  );
}

function ConceptSummary({ detail }: { detail: BrainNodeDetail }) {
  const mastery = Math.round((detail.node.score ?? 0) * 100);
  return (
    <section>
      <div className="brain-mastery" aria-label={`Mastery ${mastery} percent`}>
        <div className="brain-mastery-bar">
          <span style={{ width: `${mastery}%` }} />
        </div>
        <span className="brain-mastery-value">{mastery}%</span>
      </div>
      <p className="muted">Mastery, on {confidenceWord(detail.node.confidence)}.</p>

      {detail.assessments.length > 0 && (
        <>
          <h3>Assessments</h3>
          <ul className="brain-list">
            {detail.assessments.map((assessment) => (
              <li key={assessment.sessionId}>
                Attempt {assessment.attemptNumber}: <strong>{assessment.vivaScore}/25</strong>
                <span className="muted"> · MCQ {assessment.mcqScore}/5 · {shortDate(assessment.at)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function SessionSummary({ detail, onSelect }: { detail: BrainNodeDetail; onSelect: (id: string) => void }) {
  const self =
    detail.node.kind === 'project'
      ? hrefFor({ source: 'project', sourceId: detail.node.key })
      : detail.node.key.startsWith('thread:')
        ? hrefFor({ source: 'thread', sourceId: detail.node.key.slice('thread:'.length) })
        : null;

  return (
    <section>
      {self && (
        <p>
          <Link className="btn primary" href={self}>
            {detail.node.kind === 'project' ? 'Open project' : 'Open conversation'}
          </Link>
        </p>
      )}
      {detail.path.length > 0 && (
        <>
          <h3>The path it took</h3>
          <ol className="brain-list brain-path">
            {detail.path.map((step) => (
              <li key={step.id}>
                <button type="button" className="brain-link" onClick={() => onSelect(step.id)}>
                  {step.label}
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function MistakeSummary({ detail }: { detail: BrainNodeDetail }) {
  const occurrences = Math.max(1, Number(detail.node.metadata['occurrences'] ?? 1));
  const sessions = detail.sessions.length;
  return (
    <p className="brain-panel-note">
      Came up {occurrences} {occurrences === 1 ? 'time' : 'times'}
      {sessions > 1 ? `, in ${sessions} different sessions` : ''}.
      {occurrences > 1 && ' A slip that comes back is a gap in the model, not bad luck — worth asking about directly.'}
    </p>
  );
}
