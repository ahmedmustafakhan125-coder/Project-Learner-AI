/**
 * The recall surfaces: the "you asked this before" banner and the chips that
 * show what the brain put in front of an answer.
 *
 * What matters is where they send the learner. The banner must never navigate
 * the current tab — the new answer may still be streaming there, and opening
 * the old conversation in place would cut it off. And node ids carry colons,
 * so every link must encode them.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { QuestionRecallMatch, RecalledItem } from '@ai-edu/api-client';

import { RecallBanner } from '../components/brain/RecallBanner';
import { RecallChips } from '../components/brain/RecallChips';

const THREAD = '22222222-2222-4222-8222-222222222222';

const match: QuestionRecallMatch = {
  threadId: THREAD,
  canonical: 'what is a closure',
  askedAt: '2026-03-12T10:00:00.000Z',
  exact: true,
  similarity: 1,
  title: 'Closures in JavaScript',
  nodeId: `session:thread:${THREAD}`,
};

describe('RecallBanner', () => {
  const html = renderToStaticMarkup(<RecallBanner match={match} onDismiss={() => {}} />);

  it('says whether it was the same question or a close one, and names the conversation', () => {
    expect(html).toContain('You asked this before');
    expect(html).toContain('Closures in JavaScript');
    expect(renderToStaticMarkup(<RecallBanner match={{ ...match, exact: false }} onDismiss={() => {}} />)).toContain(
      'You asked something similar',
    );
  });

  it('opens the earlier conversation and the brain in new tabs, never in place', () => {
    const anchors = [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
    expect(anchors).toHaveLength(2);
    for (const a of anchors) {
      expect(a).toContain('target="_blank"');
      expect(a).toContain('rel="noopener noreferrer"');
    }
    expect(html).toContain(`href="/ask?thread=${THREAD}"`);
    expect(html).toContain(`href="/brain?focus=${encodeURIComponent(match.nodeId)}"`);
  });

  it('is a status message, not a dialog that blocks the page', () => {
    expect(html).toContain('role="status"');
  });
});

describe('RecallChips', () => {
  const items: RecalledItem[] = [
    { nodeId: 'concept:closures', kind: 'concept', label: 'Closures', sourceId: null },
    { nodeId: 'mistake:qa:copy', kind: 'mistake', label: 'Thinks closures copy variables by value', sourceId: 'thread-2' },
  ];

  it('renders nothing when nothing was recalled', () => {
    expect(renderToStaticMarkup(<RecallChips items={[]} />)).toBe('');
  });

  it('links each chip to its node in the brain, encoded, in a new tab', () => {
    const html = renderToStaticMarkup(<RecallChips items={items} />);
    for (const a of [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0])) expect(a).toContain('target="_blank"');
    expect(html).toContain('Recalled from your brain');
    expect(html).toContain(`href="/brain?focus=${encodeURIComponent('concept:closures')}"`);
    expect(html).toContain(`href="/brain?focus=${encodeURIComponent('mistake:qa:copy')}"`);
    expect(html).toContain('recurring mistake');
  });

  it('clips a long label at a word, keeping the whole of it in the tooltip', () => {
    const label = 'Each loop iteration with let gets a fresh binding of the counter';
    const html = renderToStaticMarkup(<RecallChips items={[{ nodeId: 'insight:z', kind: 'insight', label, sourceId: null }]} />);
    expect(html).toContain(`title="${label} — takeaway, open in your brain"`);
    // Cut back to the last whole word before the limit, never through "binding".
    expect(html).toContain('Each loop iteration with let gets a fresh…</a>');
  });
});
