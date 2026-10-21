/**
 * The replay controls and the mistakes overview, rendered to markup.
 *
 * The replay itself is `projectAt` in packages/core and is tested there; these
 * pin what the learner is offered: a closed timeline that costs nothing until
 * asked for, an open one that says what day it is showing, and — with nothing
 * selected — the mistakes that keep coming back.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ActivityDay, RecurringMistake } from '@ai-edu/core';

import { NodeDetailPanel } from '../components/brain/NodeDetailPanel';
import { TimelineScrubber } from '../components/brain/TimelineScrubber';

const days: ActivityDay[] = [
  { day: '2026-10-01', until: '2026-10-01T23:59:59.999Z', count: 2 },
  { day: '2026-10-02', until: '2026-10-02T23:59:59.999Z', count: 0 },
  { day: '2026-10-03', until: '2026-10-03T23:59:59.999Z', count: 5 },
];

const noop = () => {};

describe('TimelineScrubber', () => {
  it('starts closed: a single button, so the history is only fetched when wanted', () => {
    const html = renderToStaticMarkup(
      <TimelineScrubber days={[]} index={null} playing={false} loading={false} onOpen={noop} onChange={noop} onPlayToggle={noop} onLive={noop} />,
    );
    expect(html).toContain('Replay how your brain grew');
    expect(html).not.toContain('type="range"');
  });

  it('when open, shows the day, the events so far, a bar per day and a way back to now', () => {
    const html = renderToStaticMarkup(
      <TimelineScrubber days={days} index={2} playing={false} loading={false} onOpen={noop} onChange={noop} onPlayToggle={noop} onLive={noop} />,
    );
    expect(html).toContain('type="range"');
    expect(html).toContain('max="2"');
    expect(html).toContain('7 events so far');
    expect(html).toContain('Back to now');
    expect(html.match(/<span[^>]*class="is-past"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Play replay"');
  });

  it('counts only the days up to the one shown', () => {
    const html = renderToStaticMarkup(
      <TimelineScrubber days={days} index={0} playing={true} loading={false} onOpen={noop} onChange={noop} onPlayToggle={noop} onLive={noop} />,
    );
    expect(html).toContain('2 events so far');
    expect(html).toContain('aria-label="Pause replay"');
  });
});

describe('NodeDetailPanel with nothing selected', () => {
  const mistakes: RecurringMistake[] = [
    { id: 'mistake:qa:copy', label: 'Thinks closures copy variables by value', occurrences: 3, sessions: 2, lastSeenAt: '2026-10-03T00:00:00Z' },
    { id: 'mistake:checkpoint:s:tests', label: 'Step 1: Routes — tests failing', occurrences: 2, sessions: 1, lastSeenAt: '2026-10-02T00:00:00Z' },
  ];

  it('leads with the mistakes that keep coming back', () => {
    const html = renderToStaticMarkup(
      <NodeDetailPanel detail={null} loading={false} error={null} mistakes={mistakes} onSelect={noop} onFocus={noop} onClose={noop} />,
    );
    expect(html).toContain('Mistakes that keep coming back');
    expect(html).toContain('Thinks closures copy variables by value');
    expect(html).toContain('×3');
    expect(html).toContain('in 2 sessions');
    // A single-session pattern does not claim to span sessions.
    expect(html).not.toContain('in 1 sessions');
  });

  it('falls back to the hint alone when nothing recurs', () => {
    const html = renderToStaticMarkup(
      <NodeDetailPanel detail={null} loading={false} error={null} mistakes={[]} onSelect={noop} onFocus={noop} onClose={noop} />,
    );
    expect(html).not.toContain('Mistakes that keep coming back');
    expect(html).toContain('Click any dot');
  });
});
