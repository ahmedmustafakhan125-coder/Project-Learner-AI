'use client';

import type { DocRef, StackBrief } from '@ai-edu/core';

import { groupLayers, layerLabel } from '../lib/stackBrief';
import { LayerCard } from './LayerCard';
import { SourcesList } from './SourcesList';

/**
 * The Stack Brief, before the learner approves it (docs/project-learner.md §8).
 *
 * One card per layer, grouped by the profile's sections; what to install;
 * the architecture as plain lists (the drawn diagram is week 2); one request
 * traced through the stack; the milestones for T4 and T5; and the sources.
 * Regenerate is offered twice; Approve sends nothing but the intake id, since
 * the server approves the brief it stored.
 */

export interface StackBriefViewProps {
  brief: StackBrief;
  sources: DocRef[];
  limitedSources: boolean;
  /** Copied from a very similar project. */
  reused: boolean;
  regenerationsLeft: number;
  busy: boolean;
  onApprove: () => void;
  onRegenerate: () => void;
}

export function StackBriefView(props: StackBriefViewProps) {
  const { brief, sources, limitedSources, reused, regenerationsLeft, busy, onApprove, onRegenerate } = props;
  const component = new Map(brief.architecture.components.map((c) => [c.id, c.name]));

  return (
    <section className="stack-brief" aria-label="Stack Brief">
      <div className="blueprint-head">
        <h2>Your stack</h2>
        <p className="summary">{brief.summary}</p>
        <div className="facts">
          <span>{brief.layers.length} layers</span>
          <span>{brief.architecture.style}</span>
          {reused && <span>Adapted from a very similar project</span>}
        </div>
      </div>

      {limitedSources && (
        <div className="notice warn">
          Limited sources: some layers rest on a tech card rather than documentation read for this project.
        </div>
      )}

      {groupLayers(brief).map((group) => (
        <div className="layer-group" key={group.section}>
          <h3>{group.section}</h3>
          <div className="layer-grid">
            {group.layers.map((layer) => (
              <LayerCard key={layer.layer} layer={layer} label={layerLabel(brief, layer.layer)} sources={sources} />
            ))}
          </div>
        </div>
      ))}

      {brief.toolchain.length > 0 && (
        <div className="toolchain-card">
          <h3>What you&apos;ll install</h3>
          <ul className="tight">
            {brief.toolchain.map((tool) => (
              <li key={tool.tool}>
                <strong>{tool.tool}</strong>
                {tool.minVersion && <span className="muted"> {tool.minVersion} or later</span>}
                {(['linux', 'macos', 'windows'] as const).map((os) =>
                  tool.installHint[os] ? (
                    <div className="install-hint" key={os}>
                      <span className="muted">{os === 'macos' ? 'macOS' : os === 'linux' ? 'Linux' : 'Windows'}:</span>{' '}
                      <code>{tool.installHint[os]}</code>
                    </div>
                  ) : null,
                )}
              </li>
            ))}
          </ul>
          <p className="muted">A later version of the app checks these for you with `verify doctor`.</p>
        </div>
      )}

      <div className="blueprint-grid">
        <div>
          <h3>How it fits together</h3>
          <p>{brief.howItFitsTogether}</p>
          {brief.architecture.flows.length > 0 && (
            <ul className="tight arch-flows">
              {brief.architecture.flows.map((flow) => (
                <li key={`${flow.from}-${flow.to}-${flow.label}`}>
                  {component.get(flow.from) ?? flow.from} → {component.get(flow.to) ?? flow.to}
                  <span className="muted"> — {flow.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          {brief.milestones.length > 0 && (
            <>
              <h3>Milestones</h3>
              <ol className="tight">
                {brief.milestones.map((m, i) => (
                  <li key={m.title}>
                    <strong>{m.title}</strong>
                    <div className="why">{m.outcome}</div>
                    {i === 0 && <div className="muted">Planned now. The rest are planned as you finish each one.</div>}
                  </li>
                ))}
              </ol>
            </>
          )}
          {[...brief.friction, ...brief.risks].length > 0 && (
            <>
              <h3>Watch out for</h3>
              <ul className="tight">
                {[...brief.friction, ...brief.risks].map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      <SourcesList sources={sources} />

      <div className="actions">
        <button className="btn primary" onClick={onApprove} disabled={busy}>
          Approve stack
        </button>
        <button className="btn" onClick={onRegenerate} disabled={busy || regenerationsLeft <= 0}>
          {regenerationsLeft > 0 ? `Regenerate (${regenerationsLeft} left)` : 'No regenerations left'}
        </button>
      </div>
      <p className="muted" style={{ marginTop: 10 }}>
        Approving writes the plan against exactly this stack. Nothing is saved as a project until you start it.
      </p>
    </section>
  );
}
