import type { QuestionRecallMatch } from '@ai-edu/api-client';

/**
 * "You asked this before." An offer, not a redirect: the same words are not
 * always the same need, so the new answer arrives either way and the learner
 * decides whether the old conversation is worth reopening.
 */

function onDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return ` on ${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

export function RecallBanner({ match, onDismiss }: { match: QuestionRecallMatch; onDismiss: () => void }) {
  return (
    <div className="recall-banner" role="status">
      <div className="recall-banner-text">
        <strong>{match.exact ? 'You asked this before' : 'You asked something similar'}</strong>
        {onDate(match.askedAt)}
        {match.title && (
          <>
            {' — '}
            <span className="recall-banner-title">“{match.title}”</span>
          </>
        )}
        <span className="recall-banner-note">Your new answer is on its way either way.</span>
      </div>
      <div className="recall-banner-actions">
        {/* A new tab, so the answer streaming here is not cut off to show the old one. */}
        <a
          className="btn"
          href={`/ask?thread=${encodeURIComponent(match.threadId)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open that conversation
        </a>
        <a
          className="recall-banner-link"
          href={`/brain?focus=${encodeURIComponent(match.nodeId)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          See it in your brain
        </a>
        <button type="button" className="recall-banner-dismiss" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      </div>
    </div>
  );
}
