import type { NodeTone } from '@ai-edu/core';

/** What each colour means. Size and brightness say how strong, the colour says what kind. */
const ITEMS: Array<{ tone: NodeTone; label: string }> = [
  { tone: 'concept', label: 'Concept — bigger and brighter as you master it' },
  { tone: 'insight', label: 'Takeaway' },
  { tone: 'mistake', label: 'Mistake — grows each time it comes back' },
  { tone: 'project', label: 'Project' },
  { tone: 'session', label: 'Conversation or assessment' },
  { tone: 'pass', label: 'Checkpoint passed' },
  { tone: 'fail', label: 'Checkpoint not passed yet' },
];

export function Legend() {
  return (
    <ul className="brain-legend" aria-label="Legend">
      {ITEMS.map((item) => (
        <li key={item.tone}>
          <span className={`brain-swatch tone-${item.tone}`} aria-hidden="true" />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
