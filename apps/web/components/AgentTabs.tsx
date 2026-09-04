'use client';

import { useMemo, useState } from 'react';
import { AGENT_ORDER, type AgentKind } from '@ai-edu/core';

export interface AgentPane {
  status: 'pending' | 'streaming' | 'complete' | 'error';
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

export function AgentTabs({ panes }: { panes: AgentPanes }) {
  const [viewMode, setViewMode] = useState<'grid' | 'tabbed'>('grid');
  const [activeTab, setActiveTab] = useState<AgentKind>('simple');

  return (
    <div style={{ marginTop: '36px' }}>
      <div className="view-mode-bar">
        <div className="view-mode-toggle">
          <button
            type="button"
            className={`view-mode-btn ${viewMode === 'grid' ? 'active' : ''}`}
            onClick={() => setViewMode('grid')}
          >
            Grid View
          </button>
          <button
            type="button"
            className={`view-mode-btn ${viewMode === 'tabbed' ? 'active' : ''}`}
            onClick={() => setViewMode('tabbed')}
          >
            Tabbed View
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
          <div className="tablist" role="tablist" aria-label="Specialist Answers">
            {AGENT_ORDER.map((agent) => {
              const meta = AGENT_METADATA[agent];
              const isSelected = activeTab === agent;
              return (
                <button
                  key={agent}
                  role="tab"
                  className="tab"
                  aria-selected={isSelected}
                  aria-controls={`panel-${agent}`}
                  id={`tab-${agent}`}
                  onClick={() => setActiveTab(agent)}
                >
                  <span className={`ping-indicator`} style={{ backgroundColor: meta.accentColor, color: meta.accentColor }} />
                  <span className="agent-icon">{meta.icon}</span>
                  <div className="agent-name">
                    <span className="agent-title">{meta.title}</span>
                    <span className="agent-role">{meta.role}</span>
                  </div>
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

function AgentCard({ agent, pane }: { agent: AgentKind; pane: AgentPane }) {
  const meta = AGENT_METADATA[agent];

  return (
    <article className={`glass-panel ${meta.borderClass} agent-card`}>
      <div
        className="agent-card-ambient"
        style={{
          background: meta.ambientBg,
          top: agent === 'simple' || agent === 'concepts' ? '-40px' : 'auto',
          bottom: agent === 'industry' ? '-40px' : 'auto',
          right: agent === 'simple' ? '-40px' : 'auto',
          left: agent === 'industry' ? '-40px' : 'auto',
        }}
      />

      <header className="agent-card-header">
        <div className="agent-card-title-group">
          <span className="agent-card-icon">{meta.icon}</span>
          <h2 className="agent-card-title">{meta.title}</h2>
          <span style={{ fontSize: '11px', color: 'var(--text-faint)' }}>{meta.role}</span>
        </div>

        <div className="agent-card-status-pill">
          <span
            className="ping-indicator"
            style={{
              backgroundColor: pane.status === 'error' ? 'var(--danger)' : pane.status === 'complete' ? 'var(--success)' : meta.accentColor,
              color: pane.status === 'error' ? 'var(--danger)' : pane.status === 'complete' ? 'var(--success)' : meta.accentColor,
            }}
          />
          <span style={{ color: meta.accentColor }}>{pane.status}</span>
        </div>
      </header>

      <div className="agent-card-body">
        {pane.status === 'error' && (
          <div className="notice error" style={{ margin: 0 }}>
            {pane.error}
          </div>
        )}

        {pane.status === 'pending' && (
          <p className="skeleton">Waiting to start parallel reasoning…</p>
        )}

        {pane.status !== 'pending' && !pane.text && (
          <p className="skeleton">
            Generating stream<span className="caret" />
          </p>
        )}

        {pane.text && (
          <>
            <Answer text={pane.text} streaming={pane.status === 'streaming'} />
            {agent === 'practice' && pane.status === 'complete' && <Exercise markdown={pane.text} />}
          </>
        )}
      </div>
    </article>
  );
}

function Pane({ agent, pane }: { agent: AgentKind; pane: AgentPane }) {
  const meta = AGENT_METADATA[agent];

  return (
    <div>
      <div className="pane-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', paddingBottom: '14px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '20px' }}>{meta.icon}</span>
          <h2 style={{ fontSize: '18px', margin: 0, color: meta.accentColor }}>{meta.title}</h2>
          <span className="muted" style={{ fontSize: '12px' }}>({meta.role})</span>
        </div>
        <div className="agent-card-status-pill">
          <span className="ping-indicator" style={{ backgroundColor: meta.accentColor, color: meta.accentColor }} />
          <span style={{ color: meta.accentColor }}>{pane.status}</span>
        </div>
      </div>

      {pane.status === 'error' && (
        <div className="notice error">
          <strong>This angle failed:</strong> {pane.error}
        </div>
      )}

      {pane.status === 'pending' && <p className="skeleton">Waiting to start parallel reasoning…</p>}

      {pane.status !== 'pending' && !pane.text && (
        <p className="skeleton">
          Generating perspective<span className="caret" />
        </p>
      )}

      {pane.text && (
        <>
          <Answer text={pane.text} streaming={pane.status === 'streaming'} />
          {agent === 'practice' && pane.status === 'complete' && <Exercise markdown={pane.text} />}
        </>
      )}
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
          <span key={i}>{block.content}</span>
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
    <div style={{ position: 'relative', margin: '14px 0' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'var(--surface-3)',
          border: '1px solid var(--border-strong)',
          borderBottom: 'none',
          padding: '6px 14px',
          borderRadius: '10px 10px 0 0',
          fontSize: '11px',
          color: 'var(--text-dim)',
          fontFamily: 'var(--mono)',
        }}
      >
        <span>{lang || 'code'}</span>
        <button
          onClick={() => void copy()}
          className="btn ghost"
          style={{ padding: '2px 8px', fontSize: '11px', height: '22px' }}
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <pre style={{ margin: 0, borderRadius: '0 0 10px 10px' }}>
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
    <div className="exercise" style={{ marginTop: '16px', borderRadius: '12px', overflow: 'hidden' }}>
      <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.6)', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
        <span style={{ fontSize: '11.5px', color: 'var(--secondary)' }}>
          Isolated Sandbox Preview
        </span>
      </div>
      <iframe
        title="Practice exercise"
        sandbox="allow-scripts"
        srcDoc={html}
        referrerPolicy="no-referrer"
        style={{ width: '100%', height: '360px', border: 'none', background: '#ffffff' }}
      />
    </div>
  );
}
