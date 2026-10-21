'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  HOVER_NODE_LIMIT,
  activityTimeline,
  nodeDetail,
  projectAt,
  projectGraph,
  recurringMistakes,
  retakeReady,
  sessionPath,
  type BrainEvent,
} from '@ai-edu/core';
import { ApiError, type BrainGraph, type BrainNodeDetail } from '@ai-edu/api-client';

import { api } from '../../lib/api';
import { Legend } from './Legend';
import { NodeDetailPanel } from './NodeDetailPanel';
import { TimelineScrubber } from './TimelineScrubber';
import { TruncationChip } from './TruncationChip';

/**
 * The brain page: fetching, the time window, focus, selection and replay.
 *
 * Everything the canvas draws is decided here or below in packages/core —
 * which nodes, their styles, the path a session took. The canvas itself is
 * loaded lazily and only ever told what to show.
 *
 * Two sources for what is drawn. Live, the graph comes from the API's stored
 * projection. Replaying, it is folded here from the event log up to the chosen
 * day — the projection is a pure function, so the brain on any past day is
 * just `projectAt(events, day)`, with no history kept anywhere.
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

/** A replay takes about this many steps whatever the span, so a year plays as briskly as a week. */
const REPLAY_STEPS = 40;
const REPLAY_STEP_MS = 380;

function describe(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : 'Something went wrong.';
}

/** `?focus=<node id>` deep-links into one part of the brain — recall chips use it. */
function focusFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('focus');
}

function asOf(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function BrainView() {
  const router = useRouter();
  const [windowDays, setWindowDays] = useState<number | null>(90);
  const [focus, setFocus] = useState<string | null>(null);
  const [graph, setGraph] = useState<BrainGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BrainNodeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  /** The event log, fetched only once the learner asks to replay. */
  const [events, setEvents] = useState<BrainEvent[] | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  /** Which day of the timeline is shown; null for the live brain. */
  const [dayIndex, setDayIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);

  /** "Test me": writing a sitting takes a few seconds, and can be refused (cooldown). */
  const [testState, setTestState] = useState<{ busy: boolean; message: string | null }>({ busy: false, message: null });

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

  /* ---------------- replay ---------------- */

  const days = useMemo(() => (events ? activityTimeline(events) : []), [events]);
  const until = dayIndex !== null ? (days[dayIndex]?.until ?? null) : null;
  const replaying = until !== null && events !== null;

  // The brain as it stood that day, styled as if "now" were that day, so what
  // was recent then pulses then.
  const past = useMemo(() => (replaying ? projectAt(events, until) : null), [replaying, events, until]);
  const pastGraph = useMemo(
    () => (past && until ? projectGraph(past.nodes, past.edges, { now: until, windowDays, focus, depth: 2 }) : null),
    [past, until, windowDays, focus],
  );

  const openReplay = useCallback(async () => {
    if (events) {
      if (events.length > 0) {
        setDayIndex(0);
        setPlaying(true);
      }
      return;
    }
    setEventsLoading(true);
    setError(null);
    try {
      const log = await api.getBrainEvents();
      setEvents(log);
      if (log.length > 0) {
        setDayIndex(0);
        setPlaying(true);
      }
    } catch (err) {
      setError(describe(err));
    } finally {
      setEventsLoading(false);
    }
  }, [events]);

  useEffect(() => {
    if (!playing || dayIndex === null) return;
    if (dayIndex >= days.length - 1) {
      setPlaying(false);
      return;
    }
    const stride = Math.max(1, Math.ceil(days.length / REPLAY_STEPS));
    const timer = setTimeout(() => setDayIndex(Math.min(days.length - 1, dayIndex + stride)), REPLAY_STEP_MS);
    return () => clearTimeout(timer);
  }, [playing, dayIndex, days.length]);

  const togglePlay = useCallback(() => {
    if (playing) {
      setPlaying(false);
      return;
    }
    // Pressing play at the end starts the story again.
    if (dayIndex !== null && dayIndex >= days.length - 1) setDayIndex(0);
    setPlaying(true);
  }, [playing, dayIndex, days.length]);

  const backToNow = useCallback(() => {
    setPlaying(false);
    setDayIndex(null);
  }, []);

  /* ---------------- selection ---------------- */

  // Live detail comes from the API; while replaying it is computed from the
  // past projection instead, so the panel describes the node as it was then.
  useEffect(() => {
    if (!selectedId || replaying) {
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
  }, [selectedId, replaying]);

  const shown = pastGraph ?? graph;
  const nodes = useMemo(() => shown?.nodes ?? [], [shown]);
  const links = useMemo(() => shown?.links ?? [], [shown]);

  const shownDetail = useMemo(
    () => (past ? (selectedId ? nodeDetail(selectedId, past.nodes, past.edges) : null) : detail),
    [past, selectedId, detail],
  );

  // A session or project is drawn as the trail it took through the graph.
  const wire = useMemo(() => {
    const selected = selectedId ? nodes.find((n) => n.id === selectedId) : undefined;
    if (!selected || (selected.kind !== 'session' && selected.kind !== 'project')) return [];
    return [selected.id, ...sessionPath(selected.id, links)];
  }, [selectedId, nodes, links]);

  const mistakes = useMemo(() => recurringMistakes(nodes, links), [nodes, links]);

  // Retakes are about the learner now, so only from the live brain.
  const retakes = useMemo(() => {
    if (replaying || !graph) return [];
    const now = new Date().toISOString();
    return graph.nodes.filter((n) => retakeReady(n, now)).map((n) => ({ conceptKey: n.key, label: n.label }));
  }, [replaying, graph]);

  const testMe = useCallback(
    async (conceptKey: string) => {
      setTestState({ busy: true, message: null });
      try {
        const { assessment } = await api.startAssessment(conceptKey);
        router.push(`/assess/${assessment.id}`);
      } catch (err) {
        setTestState({ busy: false, message: describe(err) });
      }
    },
    [router],
  );

  // A message about one concept should not linger on the next.
  useEffect(() => setTestState({ busy: false, message: null }), [selectedId]);

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
    `Your brain${until ? ` as of ${asOf(until)}` : ''}: ${counts.concept} concepts, ${counts.mistake} mistakes, ` +
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

      {graph && graph.nodes.length === 0 && !loading && !replaying && (
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

      {shown && (shown.nodes.length > 0 || replaying) && (
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
            {until && <div className="brain-asof">As of {asOf(until)}</div>}
            <TruncationChip shown={shown.nodes.length} total={shown.meta.total} truncated={shown.meta.truncated} />
            <TimelineScrubber
              days={days}
              index={replaying ? dayIndex : null}
              playing={playing}
              loading={eventsLoading}
              onOpen={() => void openReplay()}
              onChange={(index) => {
                setPlaying(false);
                setDayIndex(index);
              }}
              onPlayToggle={togglePlay}
              onLive={backToNow}
            />
            <Legend />
          </div>
          <NodeDetailPanel
            detail={shownDetail}
            loading={!replaying && detailLoading}
            error={replaying ? null : detailError}
            mistakes={mistakes}
            retakes={retakes}
            {...(replaying ? {} : { onTestMe: (key: string) => void testMe(key) })}
            testState={testState}
            onSelect={select}
            onFocus={focusOn}
            onClose={() => setSelectedId(null)}
          />
        </div>
      )}
    </main>
  );
}
