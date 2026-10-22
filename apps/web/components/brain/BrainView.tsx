'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { HOVER_NODE_LIMIT, sessionPath } from '@ai-edu/core';
import { ApiError, type BrainGraph, type BrainNodeDetail } from '@ai-edu/api-client';

import { api } from '../../lib/api';
import { Legend } from './Legend';
import { NodeDetailPanel } from './NodeDetailPanel';
import { TruncationChip } from './TruncationChip';

/**
 * The brain page: fetching, the time window, focus and selection.
 *
 * Everything the canvas draws is decided here or below in packages/core —
 * which nodes, their styles, the path a session took. The canvas itself is
 * loaded lazily and only ever told what to show.
 */

const BrainCanvas = dynamic(() => import('./BrainCanvas'), {
  ssr: false,
  loading: () => <div className="brain-canvas-wrap brain-canvas-loading">Wiring up your brain…</div>,
});

const WINDOWS: Array<{ days: number | null; label: string }> = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: 'Year' },
  { days: null, label: 'All time' },
];

function describe(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : 'Something went wrong.';
}

/** `?focus=<node id>` deep-links into one part of the brain — recall chips use it. */
function focusFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('focus');
}

export function BrainView() {
  const [windowDays, setWindowDays] = useState<number | null>(90);
  const [focus, setFocus] = useState<string | null>(null);
  const [graph, setGraph] = useState<BrainGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BrainNodeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    const fromUrl = focusFromUrl();
    if (fromUrl) {
      // A deep link names one node; show all of time so it cannot be windowed out.
      setWindowDays(null);
      setFocus(fromUrl);
      setSelectedId(fromUrl);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getBrainGraph({ windowDays, focus, depth: 2 })
      .then((view) => {
        if (!cancelled) setGraph(view);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describe(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [windowDays, focus]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    api
      .getBrainNode(selectedId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setDetail(null);
          setDetailError(describe(err));
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const nodes = useMemo(() => graph?.nodes ?? [], [graph]);
  const links = useMemo(() => graph?.links ?? [], [graph]);

  // A session or project is drawn as the trail it took through the graph.
  const wire = useMemo(() => {
    const selected = selectedId ? nodes.find((n) => n.id === selectedId) : undefined;
    if (!selected || (selected.kind !== 'session' && selected.kind !== 'project')) return [];
    return [selected.id, ...sessionPath(selected.id, links)];
  }, [selectedId, nodes, links]);

  const counts = useMemo(() => {
    const byKind = { concept: 0, mistake: 0, session: 0, project: 0 };
    for (const n of nodes) if (n.kind in byKind) byKind[n.kind as keyof typeof byKind] += 1;
    return byKind;
  }, [nodes]);

  const select = useCallback((id: string | null) => setSelectedId(id), []);
  const focusOn = useCallback((id: string) => {
    setFocus(id);
    setSelectedId(id);
  }, []);

  const description =
    `Your brain: ${counts.concept} concepts, ${counts.mistake} mistakes, ` +
    `${counts.session + counts.project} sessions and projects. Use the panel beside it to explore by keyboard.`;

  return (
    <main className="shell wide brain-page">
      <header className="masthead">
        <div>
          <h1>Your brain</h1>
          <div className="sub">
            Every concept you have worked on, wired together by the sessions that connected them. Brighter and bigger
            means held more strongly.
          </div>
        </div>
      </header>

      <div className="brain-toolbar">
        <div className="brain-windows" role="group" aria-label="Time window">
          {WINDOWS.map((w) => (
            <button
              key={w.label}
              type="button"
              className="chip"
              aria-pressed={windowDays === w.days}
              onClick={() => setWindowDays(w.days)}
            >
              {w.label}
            </button>
          ))}
        </div>
        {focus && (
          <div className="brain-focus">
            Focused on <strong>{nodes.find((n) => n.id === focus)?.label ?? focus}</strong>
            <button type="button" className="btn" onClick={() => setFocus(null)}>
              Show everything
            </button>
          </div>
        )}
      </div>

      {error && <div className="notice error">{error}</div>}

      {loading && !graph && (
        <div className="brain-canvas-wrap brain-canvas-loading">Loading your brain…</div>
      )}

      {graph && graph.nodes.length === 0 && !loading && (
        <div className="brain-empty">
          <h2>{windowDays ? 'Nothing in this window yet' : 'Your brain is empty so far'}</h2>
          <p className="muted">
            Ask a question or work through a project step and it starts filling in — every concept you touch becomes a
            node, and every session draws a wire between them.
          </p>
          {windowDays ? (
            <button type="button" className="btn" onClick={() => setWindowDays(null)}>
              Show all time
            </button>
          ) : (
            <Link className="btn primary" href="/ask">
              Ask a question
            </Link>
          )}
        </div>
      )}

      {graph && graph.nodes.length > 0 && (
        <div className="brain-layout">
          <div className="brain-stage">
            <BrainCanvas
              nodes={nodes}
              links={links}
              selectedId={selectedId}
              wire={wire}
              hoverEnabled={nodes.length <= HOVER_NODE_LIMIT}
              onNodeClick={select}
              description={description}
            />
            <TruncationChip shown={graph.nodes.length} total={graph.meta.total} truncated={graph.meta.truncated} />
            <Legend />
          </div>
          <NodeDetailPanel
            detail={detail}
            loading={detailLoading}
            error={detailError}
            onSelect={select}
            onFocus={focusOn}
            onClose={() => setSelectedId(null)}
          />
        </div>
      )}
    </main>
  );
}
