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

import { LayerCard } from '../components/LayerCard';
import { ProfileChip } from '../components/ProfileChip';
import { SourcesList } from '../components/SourcesList';
import { StackBriefView } from '../components/StackBriefView';
import { TierChip } from '../components/TierChip';
import { groupLayers, researchStages, safeHref } from '../lib/stackBrief';
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

describe('scope chips', () => {
  it('shows the tier with every reason, and stops at T1 and T5', () => {
    const html = renderToStaticMarkup(
      <TierChip tier="T5" reasons={['bare metal +4', 'Profile floor: a kernel is at least T5']} overTime busy={false} onStep={() => {}} />,
    );
    expect(html).toContain('T5 · Deep systems');
    expect(html).toContain('bare metal +4');
    expect(html).toMatch(/disabled="" aria-label="Bigger project"/);
    expect(html).toContain('Milestone 1 is planned as a project on its own');
  });

  it('says when it is not sure of the profile', () => {
    const html = renderToStaticMarkup(
      <ProfileChip profile="desktop-app" confidence={0.4} alternatives={['general']} busy={false} onChange={() => {}} />,
    );
    expect(html).toContain('Desktop');
    expect(html).toContain('not sure');
  });
});

describe('researchStages', () => {
  it('reads documentation only from T2, and says when a similar project is reused', () => {
    expect(researchStages('T1', false).join(' ')).not.toMatch(/documentation/);
    expect(researchStages('T3', false).join(' ')).toMatch(/official documentation/);
    expect(researchStages('T3', true)[0]).toMatch(/similar project/);
  });
});
