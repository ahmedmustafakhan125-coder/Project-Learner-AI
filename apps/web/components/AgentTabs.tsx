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

export function AgentTabs({ panes }: { panes: AgentPanes }) {
  const [active, setActive] = useState<AgentKind>('simple');

  return (
    <div className="tabs">
      <div className="tablist" role="tablist" aria-label="Answers">
        {AGENT_ORDER.map((agent) => (
          <button
            key={agent}
            role="tab"
            className="tab"
            aria-selected={active === agent}
            aria-controls={`panel-${agent}`}
            id={`tab-${agent}`}
            onClick={() => setActive(agent)}
          >
            <span className={`dot ${panes[agent].status}`} aria-hidden="true" />
            {AGENT_LABELS[agent]}
          </button>
        ))}
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
  if (pane.status === 'error') {
    return (
      <div className="notice error">
        <strong>This angle failed.</strong> {pane.error}
        <div className="muted" style={{ marginTop: 6 }}>
          The other answers are unaffected — check the remaining tabs.
        </div>
      </div>
    );
  }

  if (pane.status === 'pending') {
    return <p className="skeleton">Waiting to start…</p>;
  }

  if (!pane.text) {
    return (
      <p className="skeleton">
        Thinking<span className="caret" />
      </p>
    );
  }

  return (
    <>
      <Answer text={pane.text} streaming={pane.status === 'streaming'} />
      {agent === 'practice' && pane.status === 'complete' && <Exercise markdown={pane.text} />}
    </>
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
          <pre key={i}>
            <code>{block.content}</code>
          </pre>
        ) : (
          <span key={i}>{block.content}</span>
        ),
      )}
      {streaming && <span className="caret" aria-hidden="true" />}
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
    <div className="exercise">
      <div className="bar">
        <span>Runs in an isolated sandbox — it cannot reach this page or the network.</span>
      </div>
      <iframe
        title="Practice exercise"
        sandbox="allow-scripts"
        srcDoc={html}
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
