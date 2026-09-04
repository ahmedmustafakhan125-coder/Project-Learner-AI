'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { AGENT_ORDER, type AgentKind } from '@ai-edu/core';
import { renderMarkdown } from '@/lib/markdown';

export interface AgentPane {
  status: 'pending' | 'streaming' | 'complete' | 'error' | 'cancelled';
  text: string;
  error: string | null;
}

export type AgentPanes = Record<AgentKind, AgentPane>;

export function emptyPanes(): AgentPanes {
  return Object.fromEntries(
    AGENT_ORDER.map((agent) => [agent, { status: 'pending', text: '', error: null }]),
  ) as AgentPanes;
}

const AGENT_METADATA: Record<
  AgentKind,
  {
    icon: string;
    title: string;
    role: string;
    borderClass: string;
    ambientBg: string;
    accentColor: string;
  }
> = {
  simple: {
    icon: '✦',
    title: 'Conceptual Guide',
    role: 'Intuitive Theory & Mechanism',
    borderClass: 'border-gradient-primary',
    ambientBg: 'var(--agent-conceptual-bg)',
    accentColor: 'var(--agent-conceptual)',
  },
  industry: {
    icon: '✦',
    title: 'Practical Engineer',
    role: 'Production Systems & Real Code',
    borderClass: 'border-gradient-tertiary',
    ambientBg: 'var(--agent-practical-bg)',
    accentColor: 'var(--agent-practical)',
  },
  practice: {
    icon: '✦',
    title: 'Interactive Sandbox',
    role: 'Hands-on Runnable Exercise',
    borderClass: 'border-gradient-secondary',
    ambientBg: 'var(--agent-interactive-bg)',
    accentColor: 'var(--agent-interactive)',
  },
  concepts: {
    icon: '✦',
    title: 'Key Takeaways',
    role: 'Core Facts & Gotchas',
    borderClass: 'border-gradient-warning',
    ambientBg: 'var(--agent-takeaways-bg)',
    accentColor: 'var(--agent-takeaways)',
  },
};

/*
 * Raw status keys used to reach the screen verbatim — a learner watching four
 * cards read "pending" learns nothing about whether the app is stuck. Each
 * status now carries its own words and its own colour token, so the state is
 * legible without decoding jargon and never renders low-contrast grey on white.
 */
const STATUS_LABEL: Record<AgentPane['status'], string> = {
  pending: 'Queued',
  streaming: 'Writing',
  complete: 'Ready',
  error: 'Failed',
  cancelled: 'Stopped',
};

function statusColor(status: AgentPane['status'], accent: string): string {
  if (status === 'error') return 'var(--danger)';
  if (status === 'cancelled') return 'var(--warn)';
  if (status === 'complete') return 'var(--success)';
  if (status === 'pending') return 'var(--text-dim)';
  return accent;
}

export interface AgentTabsProps {
  panes: AgentPanes;
  /**
   * True once nothing is still streaming. Drives the automatic hand-off from
   * the four-up grid (useful while all four write at once) to the tabbed
   * reading view (useful once there is a finished answer to actually read).
   */
  complete?: boolean;
}

export function AgentTabs({ panes, complete = false }: AgentTabsProps) {
  const [viewMode, setViewMode] = useState<'grid' | 'tabbed'>(complete ? 'tabbed' : 'grid');
  const [activeTab, setActiveTab] = useState<AgentKind>('simple');

  /*
   * Watching four answers race is the point of the grid; reading one of them is
   * the point of the tabs. Switching on completion — and back on the next run —
   * gives each view the phase it is actually good at. A manual toggle still
   * wins until the phase changes again, because this fires on the flip only.
   */
  useEffect(() => {
    setViewMode(complete ? 'tabbed' : 'grid');
  }, [complete]);

  return (
    <div className="agent-results">
      <div className="view-mode-bar">
        <div className="view-mode-toggle" role="group" aria-label="Answer layout">
          <button
            type="button"
            className={`view-mode-btn ${viewMode === 'grid' ? 'active' : ''}`}
            aria-pressed={viewMode === 'grid'}
            onClick={() => setViewMode('grid')}
          >
            Grid view
          </button>
          <button
            type="button"
            className={`view-mode-btn ${viewMode === 'tabbed' ? 'active' : ''}`}
            aria-pressed={viewMode === 'tabbed'}
            onClick={() => setViewMode('tabbed')}
          >
            Tabbed view
          </button>
        </div>
      </div>

      {viewMode === 'grid' ? (
        <div className="parallel-grid">
          {AGENT_ORDER.map((agent) => (
            <AgentCard key={agent} agent={agent} pane={panes[agent]} />
          ))}
        </div>
      ) : (
        <div className="tabs">
          <div className="tablist" role="tablist" aria-label="Specialist answers">
            {AGENT_ORDER.map((agent) => {
              const meta = AGENT_METADATA[agent];
              const pane = panes[agent];
              const isSelected = activeTab === agent;
              return (
                <button
                  key={agent}
                  type="button"
                  role="tab"
                  className="tab"
                  style={{ ['--tab-accent' as string]: meta.accentColor }}
                  aria-selected={isSelected}
                  aria-controls={`panel-${agent}`}
                  id={`tab-${agent}`}
                  onClick={() => setActiveTab(agent)}
                >
                  <span className="tab-glyph" style={{ color: meta.accentColor }}>
                    {meta.icon}
                  </span>
                  <span className="agent-name">
                    <span className="agent-title">{meta.title}</span>
                    <span className="agent-role">{meta.role}</span>
                  </span>
                  <StatusDot pane={pane} accent={meta.accentColor} />
                </button>
              );
            })}
          </div>

          <div
            className="panel"
            role="tabpanel"
            id={`panel-${activeTab}`}
            aria-labelledby={`tab-${activeTab}`}
          >
            <Pane agent={activeTab} pane={panes[activeTab]} />
          </div>
        </div>
      )}
    </div>
  );
}

/** The one dot that says "this tab is still writing" without stealing the label. */
function StatusDot({ pane, accent }: { pane: AgentPane; accent: string }) {
  const color = statusColor(pane.status, accent);
  return (
    <span
      className={`tab-status-dot ${pane.status === 'streaming' ? 'ping-indicator' : ''}`}
      style={{ backgroundColor: color, color }}
      title={STATUS_LABEL[pane.status]}
      aria-label={STATUS_LABEL[pane.status]}
    />
  );
}

function StatusPill({ pane, accent }: { pane: AgentPane; accent: string }) {
  const color = statusColor(pane.status, accent);
  return (
    <span className="agent-card-status-pill" style={{ color, borderColor: color }}>
      <span
        className={`tab-status-dot ${pane.status === 'streaming' ? 'ping-indicator' : ''}`}
        style={{ backgroundColor: color, color }}
        aria-hidden="true"
      />
      {STATUS_LABEL[pane.status]}
    </span>
  );
}

/** Everything below the header, shared by the grid card and the tab panel. */
function PaneBody({ agent, pane }: { agent: AgentKind; pane: AgentPane }) {
  return (
    <>
      {pane.status === 'error' && (
        <div className="notice error" style={{ marginTop: 0 }}>
          <strong>This angle failed.</strong> {pane.error ?? 'The specialist did not respond.'}
        </div>
      )}

      {pane.status === 'cancelled' && (
        <div className="notice warn" style={{ marginTop: 0 }}>
          You stopped this answer{pane.text ? ' — what arrived first is kept below.' : '.'}
        </div>
      )}

      {pane.status === 'pending' && (
        <p className="loading-line">
          <span className="loading-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          Waiting to start…
        </p>
      )}

      {pane.status === 'streaming' && !pane.text && (
        <p className="loading-line">
          <span className="loading-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          Reasoning…
        </p>
      )}

      {pane.text && (
        <>
          <Answer text={pane.text} streaming={pane.status === 'streaming'} />
          {agent === 'practice' && pane.status === 'complete' && <Exercise markdown={pane.text} />}
        </>
      )}
    </>
  );
}

function AgentCard({ agent, pane }: { agent: AgentKind; pane: AgentPane }) {
  const meta = AGENT_METADATA[agent];

  return (
    <article className={`glass-panel ${meta.borderClass} agent-card`}>
      <div
        className="agent-card-ambient"
        style={{ background: meta.ambientBg, top: '-40px', right: '-40px' }}
      />

      <header className="agent-card-header">
        <div className="agent-card-title-group">
          <span className="agent-card-icon" style={{ color: meta.accentColor }}>
            {meta.icon}
          </span>
          <h2 className="agent-card-title">{meta.title}</h2>
          <span className="agent-card-role">{meta.role}</span>
        </div>

        <StatusPill pane={pane} accent={meta.accentColor} />
      </header>

      <div className="agent-card-body">
        <PaneBody agent={agent} pane={pane} />
      </div>
    </article>
  );
}

function Pane({ agent, pane }: { agent: AgentKind; pane: AgentPane }) {
  const meta = AGENT_METADATA[agent];

  return (
    <div>
      <div className="pane-header">
        <div className="pane-header-title">
          <span className="pane-header-icon" style={{ color: meta.accentColor }}>
            {meta.icon}
          </span>
          <h2 style={{ color: meta.accentColor }}>{meta.title}</h2>
          <span className="pane-header-role">{meta.role}</span>
        </div>
        <StatusPill pane={pane} accent={meta.accentColor} />
      </div>

      <PaneBody agent={agent} pane={pane} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function Answer({ text, streaming }: { text: string; streaming: boolean }) {
  const blocks = useMemo(() => splitFences(text), [text]);

  return (
    <div className="answer">
      {blocks.map((block, i) =>
        block.type === 'code' ? (
          <CodeBlock key={i} content={block.content} lang={block.lang} />
        ) : (
          // Rendered, not raw. `renderMarkdown` builds React elements, so a tag
          // in model output stays text — the invariant is about raw HTML, not
          // about leaving `### heading` on screen for the learner to decode.
          <Fragment key={i}>{renderMarkdown(block.content, `a${i}`)}</Fragment>
        ),
      )}
      {streaming && <span className="caret" aria-hidden="true" />}
    </div>
  );
}

function CodeBlock({ content, lang }: { content: string; lang: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard error
    }
  };

  return (
    <div className="code-block">
      <div className="code-block-head">
        <span>{lang || 'code'}</span>
        <button type="button" onClick={() => void copy()} className="code-block-copy">
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{content}</code>
      </pre>
    </div>
  );
}

interface Block {
  type: 'text' | 'code';
  content: string;
  lang: string;
}

export function splitFences(text: string): Block[] {
  const blocks: Block[] = [];
  const fence = /```(\w*)\n?([\s\S]*?)(?:```|$)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(text)) !== null) {
    if (match.index > cursor) {
      blocks.push({ type: 'text', content: text.slice(cursor, match.index), lang: '' });
    }
    blocks.push({ type: 'code', content: match[2] ?? '', lang: match[1] ?? '' });
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    blocks.push({ type: 'text', content: text.slice(cursor), lang: '' });
  }

  return blocks;
}

function Exercise({ markdown }: { markdown: string }) {
  const html = useMemo(() => {
    const block = splitFences(markdown).find((b) => b.type === 'code' && /^html?$/i.test(b.lang));
    return block?.content ?? null;
  }, [markdown]);

  if (!html) return null;

  return (
    <div className="exercise">
      <div className="exercise-head">
        <span className="exercise-dot" aria-hidden="true" />
        Isolated sandbox preview
      </div>
      <iframe
        title="Practice exercise"
        sandbox="allow-scripts"
        srcDoc={html}
        referrerPolicy="no-referrer"
        className="exercise-frame"
      />
    </div>
  );
}
