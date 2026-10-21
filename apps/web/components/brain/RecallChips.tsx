import type { RecalledItem } from '@ai-edu/api-client';

/**
 * What the brain put in front of the agents for this answer.
 *
 * Shown because personalisation a learner cannot see is personalisation they
 * cannot question. Each chip opens the brain at the node it came from — in a
 * new tab, because the chips appear while the answer is still streaming and
 * navigating away would abandon it.
 */

const KIND_LABEL: Record<RecalledItem['kind'], string> = {
  concept: 'mastery',
  mistake: 'recurring mistake',
  insight: 'takeaway',
};

/** Short enough to sit in a chip, cut at a word rather than through one. */
function clip(label: string, max = 48): string {
  if (label.length <= max) return label;
  const cut = label.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function RecallChips({
  items,
  heading = 'Recalled from your brain',
}: {
  items: readonly RecalledItem[];
  heading?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="recall-chips" aria-label={heading}>
      <span className="recall-chips-heading">{heading}</span>
      {items.map((item) => (
        <a
          key={item.nodeId}
          className={`recall-chip kind-${item.kind}`}
          href={`/brain?focus=${encodeURIComponent(item.nodeId)}`}
          target="_blank"
          rel="noopener noreferrer"
          title={`${item.label} — ${KIND_LABEL[item.kind]}, open in your brain`}
        >
          <span className="recall-chip-kind">{KIND_LABEL[item.kind]}</span>
          {clip(item.label)}
        </a>
      ))}
    </div>
  );
}
