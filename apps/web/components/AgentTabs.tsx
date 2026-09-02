'use client';

import { useMemo, useState } from 'react';
import { AGENT_LABELS, AGENT_ORDER, type AgentKind } from '@ai-edu/core';

/**
 * The four answers, one tab each.
 *
 * All four stream concurrently, so the tab strip carries a status dot per agent
 * — a learner reading the plain explanation can see the other three filling in
 * behind it and switch when one is ready. Hiding that would make three of the
 * four look broken until they finished.
 */

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
  { icon: string; role: string; badgeClass: string }
> = {
  simple: { icon: '💡', role: 'Intuitive & Plain Language', badgeClass: 'conceptual' },
  industry: { icon: '🛠️', role: 'Real-World Systems & Code', badgeClass: 'practical' },
  practice: { icon: '🎮', role: 'Interactive Sandbox Exercise', badgeClass: 'interactive' },
  concepts: { icon: '📋', role: 'Core Takeaways & Traps', badgeClass: 'takeaways' },
};

export function AgentTabs({ panes }: { panes: AgentPanes }) {
  const [active, setActive] = useState<AgentKind>('simple');

  return (
    <div className="tabs">
      <div className="tablist" role="tablist" aria-label="Specialist Answers">
        {AGENT_ORDER.map((agent) => {
          const meta = AGENT_METADATA[agent];
          const isSelected = active === agent;
          return (
            <button
              key={agent}
              role="tab"
              className="tab"
              aria-selected={isSelected}
              aria-controls={`panel-${agent}`}
              id={`tab-${agent}`}
              onClick={() => setActive(agent)}
            >
              <span className={`dot ${panes[agent].status}`} aria-hidden="true" />
              <span className="agent-icon">{meta.icon}</span>
              <div className="agent-name">
                <span className="agent-title">{AGENT_LABELS[agent]}</span>
                <span className="agent-role">{meta.role}</span>
              </div>
            </button>
          );
        })}
      </div>

      <div
        className="panel"
        role="tabpanel"
        id={`panel-${active}`}
        aria-labelledby={`tab-${active}`}
      >
        <Pane agent={active} pane={panes[active]} />
      </div>
    </div>
  );
}

function Pane({ agent, pane }: { agent: AgentKind; pane: AgentPane }) {
  const meta = AGENT_METADATA[agent];

  return (
    <div>
      <div className="pane-header">
        <div className={`pane-badge ${meta.badgeClass}`}>
          <span>{meta.icon}</span>
          <span>{AGENT_LABELS[agent]} Specialist</span>
        </div>
        <div className="muted" style={{ fontSize: '12px' }}>
          {pane.status === 'streaming' && '⚡ Generating stream…'}
          {pane.status === 'complete' && '✓ Ready'}
          {pane.status === 'pending' && '⏳ Waiting for queue…'}
        </div>
      </div>

      {pane.status === 'error' && (
        <div className="notice error">
          <strong>This angle failed:</strong> {pane.error}
          <div className="muted" style={{ marginTop: 6 }}>
            The other answers are unaffected — check the remaining tabs.
          </div>
        </div>
      )}

      {pane.status === 'pending' && <p className="skeleton">Waiting to start parallel reasoning…</p>}

      {pane.status !== 'pending' && !pane.text && (
        <p className="skeleton">
          Formulating perspective<span className="caret" />
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

/**
 * Deliberately NOT a markdown library.
 *
 * Model output is untrusted text, and a full markdown renderer with raw-HTML
 * support is a direct XSS path. This splits fenced code from prose and renders
 * both as plain text nodes, so nothing in an answer can become live markup.
 */
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
          background: '#161822',
          border: '1px solid rgba(255,255,255,0.1)',
          borderBottom: 'none',
          padding: '6px 14px',
          borderRadius: '8px 8px 0 0',
          fontSize: '11.5px',
          color: '#94a3b8',
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
      <pre style={{ margin: 0, borderRadius: '0 0 8px 8px' }}>
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

/* ------------------------------------------------------------------ *
 * Exercise sandbox
 * ------------------------------------------------------------------ */

/**
 * Runs the practice agent's generated HTML.
 *
 * `sandbox="allow-scripts"` WITHOUT `allow-same-origin` is the load-bearing
 * detail: that combination gives the frame an opaque origin, so its scripts run
 * but cannot reach this page's DOM, cookies, or storage. Adding
 * `allow-same-origin` alongside `allow-scripts` would let the frame remove its
 * own sandbox attribute entirely — the two together are equivalent to no
 * sandbox at all.
 */
function Exercise({ markdown }: { markdown: string }) {
  const html = useMemo(() => {
    const block = splitFences(markdown).find((b) => b.type === 'code' && /^html?$/i.test(b.lang));
    return block?.content ?? null;
  }, [markdown]);

  if (!html) return null;

  return (
    <div className="exercise" style={{ marginTop: '20px', borderRadius: '12px', overflow: 'hidden' }}>
      <div className="bar" style={{ padding: '8px 16px', background: '#181a24' }}>
        <span style={{ fontSize: '12px', color: '#a5b4fc' }}>
          ⚡ Isolated Sandbox Preview (Safe Execution Environment)
        </span>
      </div>
      <iframe
        title="Practice exercise"
        sandbox="allow-scripts"
        srcDoc={html}
        referrerPolicy="no-referrer"
        style={{ width: '100%', height: '460px', border: 'none', background: '#ffffff' }}
      />
    </div>
  );
}
