/**
 * The Stack Brief screen (docs/project-learner.md §8, "What the learner sees").
 *
 * Rendered from the recorded live Tauri and kernel briefs: one card per layer
 * grouped by the profile's own sections, a verification badge and its source
 * links on every card, alternatives folded away, regenerate offered twice,
 * and no link that is not http or https.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ResearchDossier, StackBrief } from '@ai-edu/core';
import type { DocRef } from '@ai-edu/core';

import { IntakeProgress } from '../components/IntakeProgress';
import { LayerCard } from '../components/LayerCard';
import { SourcesList } from '../components/SourcesList';
import { StackBriefView } from '../components/StackBriefView';
import { progressSteps, researchLines } from '../lib/intakeProgress';
import { groupLayers, safeHref } from '../lib/stackBrief';
import kernel from '../../../packages/core/test/fixtures/briefs/kernel.json';
import tauri from '../../../packages/core/test/fixtures/briefs/tauri.json';

const load = (r: unknown) => {
  const x = r as { brief: unknown; dossier: unknown };
  const brief = StackBrief.parse(x.brief);
  const dossier = ResearchDossier.parse(x.dossier);
  const ids = new Set(brief.layers.flatMap((l) => l.docRefs));
  return { brief, sources: dossier.docRefs.filter((d) => ids.has(d.id)) };
};
const TAURI = load(tauri);
const KERNEL = load(kernel);

const view = (over: Partial<Parameters<typeof StackBriefView>[0]> = {}) =>
  renderToStaticMarkup(
    <StackBriefView
      brief={TAURI.brief}
      sources={TAURI.sources}
      limitedSources={false}
      reused={false}
      regenerationsLeft={2}
      busy={false}
      onApprove={() => {}}
      onRegenerate={() => {}}
      {...over}
    />,
  );

describe('groupLayers', () => {
  it("groups a kernel's layers in its profile's section order", () => {
    const sections = groupLayers(KERNEL.brief).map((g) => g.section);
    expect(sections[0]).toBe('Toolchain');
    expect(new Set(sections).size).toBe(sections.length);
    expect(groupLayers(KERNEL.brief).flatMap((g) => g.layers)).toHaveLength(KERNEL.brief.layers.length);
  });
});

describe('StackBriefView', () => {
  it('shows one card per layer, each with a verification badge and a source link', () => {
    const html = view();
    expect(html.match(/class="layer-card"/g)).toHaveLength(TAURI.brief.layers.length);
    expect(html.match(/class="verify-badge/g)!.length).toBe(TAURI.brief.layers.length);
    expect(html).toContain('href="https://v2.tauri.app/start/"');
    expect(html).toContain('Approve stack');
  });

  it('folds alternatives under "Other options"', () => {
    expect(view()).toMatch(/<details class="layer-alternatives"><summary>Other options/);
  });

  it('offers regenerate twice, then says there are none left', () => {
    expect(view({ regenerationsLeft: 2 })).toContain('Regenerate (2 left)');
    const spent = view({ regenerationsLeft: 0 });
    expect(spent).toContain('No regenerations left');
    expect(spent).toMatch(/<button class="btn" disabled="">No regenerations left/);
  });

  it('says when sources are limited, and when the brief was reused', () => {
    expect(view({ limitedSources: true })).toContain('Limited sources');
    expect(view({ reused: true })).toContain('Adapted from a very similar project');
  });

  it('lists what to install, per host OS, for a kernel', () => {
    const html = view({ brief: KERNEL.brief, sources: KERNEL.sources });
    expect(html).toContain('What you&#x27;ll install');
    expect(html).toContain('Milestones');
  });
});

describe('links', () => {
  const ref = (url: string): DocRef => ({ id: 'd9', url, title: 'Page', citedText: '', retrievedAt: 't', vetted: true });

  it('never renders a javascript: link, and opens the rest in a new tab without an opener', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    const html = renderToStaticMarkup(<SourcesList sources={[ref('javascript:alert(1)'), ref('https://docs.python.org/3/')]} />);
    expect(html).not.toContain('javascript:');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it('marks unvetted sources', () => {
    const html = renderToStaticMarkup(<SourcesList sources={[{ ...ref('https://example.org/'), vetted: false }]} />);
    expect(html).toContain('unvetted');
  });

  it('shows a layer the learner asked for as theirs', () => {
    const layer = { ...TAURI.brief.layers[0]!, requestedByLearner: true };
    expect(renderToStaticMarkup(<LayerCard layer={layer} label="UI" sources={TAURI.sources} />)).toContain('You asked for this');
  });
});

/*
 * The profile and tier chips are gone: the learner never sees the tier. One
 * progress card runs from scoping to the brief, and a failed step offers Try
 * again where it failed.
 */
describe('the progress card', () => {
  const base = { failed: false, askedMore: false, adapted: false, tier: 'T3' as const, tick: 0 };

  it('marks what is done, what runs and what waits, and never names the tier', () => {
    const steps = progressSteps({ ...base, current: 'research', askedMore: true });
    expect(steps.map((s) => [s.id, s.status])).toEqual([
      ['scope', 'done'],
      ['questions', 'done'],
      ['research', 'active'],
      ['brief', 'todo'],
    ]);
    const html = renderToStaticMarkup(<IntakeProgress steps={steps} />);
    expect(html).toContain('Reading the documentation');
    expect(html).toContain('Reading the tech cards');
    expect(html).not.toMatch(/\bT[1-5]\b|Standard|Full app|Deep systems/);
  });

  it('shows the questions step only when a second round was asked', () => {
    expect(progressSteps({ ...base, current: 'scope' }).map((s) => s.id)).toEqual(['scope', 'research', 'brief']);
  });

  it('moves the bar only while the app works, not while the learner answers', () => {
    const answering = renderToStaticMarkup(<IntakeProgress steps={progressSteps({ ...base, current: 'questions', askedMore: true })} />);
    const reading = renderToStaticMarkup(<IntakeProgress steps={progressSteps({ ...base, current: 'research', askedMore: true })} />);
    expect(answering).not.toContain('plan-progress-bar');
    expect(reading).toContain('plan-progress-bar');
  });

  it('puts the error and Try again beside the step that failed', () => {
    const steps = progressSteps({ ...base, current: 'brief', failed: true });
    expect(steps.at(-1)).toMatchObject({ id: 'brief', status: 'failed' });
    const html = renderToStaticMarkup(<IntakeProgress steps={steps} error="The Stack Brief did not pass its checks." onRetry={() => {}} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Try again');
    expect(html).not.toContain('plan-progress-bar');
  });

  it('reads documentation only from T2, and says when a similar project is reused', () => {
    expect(researchLines('T1', false).join(' ')).not.toMatch(/documentation/);
    expect(researchLines('T3', false).join(' ')).toMatch(/official documentation/);
    expect(researchLines('T3', true)[0]).toMatch(/similar project/);
    expect(progressSteps({ ...base, current: 'research', adapted: true })[1]?.label).toMatch(/similar project/);
  });

  it('holds the last line while a step runs long', () => {
    const steps = progressSteps({ ...base, current: 'brief', tick: 99 });
    expect(steps.at(-1)?.detail).toBe('Checking every layer against its sources…');
  });
});
