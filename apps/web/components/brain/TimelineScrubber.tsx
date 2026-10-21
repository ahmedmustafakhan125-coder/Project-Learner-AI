'use client';

import type { ActivityDay } from '@ai-edu/core';

/**
 * Scrub or play through the brain's history.
 *
 * One stop per calendar day, quiet days included, with a bar for how much
 * happened that day. The parent folds the event log up to the chosen day —
 * this component only picks the day.
 */

interface TimelineScrubberProps {
  days: ActivityDay[];
  /** Index into `days`, or null for the live brain. */
  index: number | null;
  playing: boolean;
  loading: boolean;
  onOpen: () => void;
  onChange: (index: number) => void;
  onPlayToggle: () => void;
  onLive: () => void;
}

function longDate(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function TimelineScrubber({
  days,
  index,
  playing,
  loading,
  onOpen,
  onChange,
  onPlayToggle,
  onLive,
}: TimelineScrubberProps) {
  // Closed: one quiet button, so the log is only fetched for someone who wants it.
  if (index === null) {
    return (
      <div className="brain-timeline brain-timeline-closed">
        <button type="button" className="btn" onClick={onOpen} disabled={loading}>
          {loading ? 'Loading your history…' : '▶ Replay how your brain grew'}
        </button>
      </div>
    );
  }

  const current = days[index];
  const busiest = Math.max(1, ...days.map((d) => d.count));
  const total = days.slice(0, index + 1).reduce((sum, d) => sum + d.count, 0);

  return (
    <div className="brain-timeline" role="group" aria-label="Brain history">
      <button
        type="button"
        className="brain-timeline-play"
        onClick={onPlayToggle}
        aria-label={playing ? 'Pause replay' : 'Play replay'}
      >
        {playing ? '❚❚' : '▶'}
      </button>

      <div className="brain-timeline-track">
        <div className="brain-timeline-bars" aria-hidden="true">
          {days.map((d, i) => (
            <span
              key={d.day}
              className={i <= index ? 'is-past' : undefined}
              style={{ height: `${d.count === 0 ? 0 : 15 + (85 * d.count) / busiest}%` }}
            />
          ))}
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(0, days.length - 1)}
          step={1}
          value={index}
          onChange={(event) => onChange(Number(event.target.value))}
          aria-label="Day"
          aria-valuetext={current ? longDate(current.day) : undefined}
        />
      </div>

      <div className="brain-timeline-label" aria-live="polite">
        <strong>{current ? longDate(current.day) : ''}</strong>
        <span className="muted">
          {total} {total === 1 ? 'event' : 'events'} so far
        </span>
      </div>

      <button type="button" className="btn" onClick={onLive}>
        Back to now
      </button>
    </div>
  );
}
