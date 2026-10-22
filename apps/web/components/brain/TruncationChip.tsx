/**
 * Honest about a cut graph. The API caps what it sends; when it had to cut,
 * the learner is told how much they are not seeing, not left to assume this
 * is everything.
 */
export function TruncationChip({ shown, total, truncated }: { shown: number; total: number; truncated: boolean }) {
  if (!truncated) return null;
  return (
    <div
      className="brain-truncation"
      role="status"
      title="The most recently touched part of your brain is shown. Narrow the time window or focus on a node to see the rest."
    >
      Showing {shown} of {total}
    </div>
  );
}
