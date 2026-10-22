import Link from 'next/link';
import { ApiError, type BrainGraph } from '@ai-edu/api-client';

/**
 * What the brain page shows when there is no graph to draw.
 *
 * Four different situations, and telling them apart is the point — each one
 * means something different to the learner and asks them to do something
 * different:
 *
 *   new          no brain has formed yet: a new account, or nothing learned
 *   window       a brain exists, but nothing in the time window chosen
 *   unavailable  the server answering does not have the brain at all (an API
 *                older than the web app) — not the learner's doing
 *   error        anything else went wrong loading it
 *
 * A raw server message ("Route GET:/api/brain/graph not found") is never
 * shown: it means nothing to a learner and reads as if their brain is broken.
 */

export type BrainEmptyVariant = 'new' | 'window' | 'unavailable' | 'error';

/** Which empty state an empty graph means. */
export function emptyVariantFor(graph: Pick<BrainGraph, 'meta'>, windowDays: number | null): BrainEmptyVariant {
  // `brainSize` tells an empty brain from an empty window. A server too old
  // to send it gets the cautious reading: with a window set, the brain may
  // well have older activity.
  const size = (graph.meta as { brainSize?: number }).brainSize;
  if (size === 0) return 'new';
  if (size === undefined) return windowDays ? 'window' : 'new';
  return 'window';
}

/** Which state a failed load means. A 404 is a route the server does not have. */
export function errorVariantFor(err: unknown): BrainEmptyVariant {
  return err instanceof ApiError && err.status === 404 ? 'unavailable' : 'error';
}

const COPY: Record<BrainEmptyVariant, { title: string; body: string }> = {
  new: {
    title: 'No neural network formed yet',
    body:
      'Your brain grows as you learn. Ask a question or work through a project step, and every concept you touch ' +
      'becomes a node here — wired to the others by the sessions that connected them.',
  },
  window: {
    title: 'Nothing in this window yet',
    body: 'Your brain has connections from earlier than this. Widen the window to see them.',
  },
  unavailable: {
    title: 'Your brain isn’t available yet',
    body:
      'This server hasn’t been updated to the version with the brain. Once it is, your brain starts forming from ' +
      'your next question.',
  },
  error: {
    title: 'Your brain couldn’t be loaded',
    body: 'Something went wrong reaching the server. Nothing is lost — try again in a moment.',
  },
};

/**
 * A dormant network: faint nodes and unlit wires, drawn once and decorative
 * only. It sits where the live graph would, so the page looks the same shape
 * whether or not there is anything in it yet.
 */
function DormantNetwork() {
  const nodes: Array<[number, number, number]> = [
    [120, 70, 5], [210, 40, 4], [300, 85, 6], [390, 50, 4], [470, 95, 5],
    [160, 150, 4], [255, 170, 5], [350, 145, 4], [440, 175, 6], [530, 130, 4],
  ];
  const wires: Array<[number, number]> = [
    [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 2], [6, 7], [7, 3], [7, 8], [8, 4], [8, 9], [4, 9],
  ];
  return (
    <svg className="brain-dormant" viewBox="60 10 540 200" aria-hidden="true" focusable="false">
      {wires.map(([a, b]) => {
        const [x1, y1] = nodes[a] as [number, number, number];
        const [x2, y2] = nodes[b] as [number, number, number];
        return <line key={`${a}-${b}`} x1={x1} y1={y1} x2={x2} y2={y2} />;
      })}
      {nodes.map(([x, y, r], i) => (
        <circle key={i} cx={x} cy={y} r={r} style={{ animationDelay: `${(i % 5) * 0.6}s` }} />
      ))}
    </svg>
  );
}

export function BrainEmptyState({
  variant,
  onShowAllTime,
  onRetry,
}: {
  variant: BrainEmptyVariant;
  onShowAllTime?: () => void;
  onRetry?: () => void;
}) {
  const { title, body } = COPY[variant];
  return (
    <section className={`brain-empty-stage is-${variant}`} aria-live="polite">
      <DormantNetwork />
      <div className="brain-empty-copy">
        <h2>{title}</h2>
        <p>{body}</p>
        <div className="brain-empty-actions">
          {variant === 'new' && (
            <>
              <Link className="btn primary" href="/ask">
                Ask your first question
              </Link>
              <Link className="btn" href="/projects/new">
                Start a project
              </Link>
            </>
          )}
          {variant === 'window' && onShowAllTime && (
            <button type="button" className="btn primary" onClick={onShowAllTime}>
              Show all time
            </button>
          )}
          {(variant === 'unavailable' || variant === 'error') && onRetry && (
            <button type="button" className="btn primary" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
