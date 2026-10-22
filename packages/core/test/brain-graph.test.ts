import { describe, expect, it } from 'vitest';

import { GRAPH_LIMITS, nodeDetail, projectGraph, sessionPath, styleFor } from '../src/brain/graph.js';
import { brainNodeId, projectBrain } from '../src/brain/project.js';
import type { BrainEdge, BrainEvent, BrainNode } from '../src/brain/types.js';

const NOW = '2026-10-22T12:00:00.000Z';
const THREAD = '00000000-0000-4000-8000-00000000000a';
const ASSESS = '00000000-0000-4000-8000-0000000000x1';

const daysAgo = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

function node(id: string, kind: BrainNode['kind'], lastSeenDaysAgo: number, extra: Partial<BrainNode> = {}): BrainNode {
  return {
    id,
    kind,
    key: id.split(':').slice(1).join(':'),
    label: id,
    score: null,
    confidence: null,
    metadata: {},
    firstSeenAt: daysAgo(lastSeenDaysAgo),
    lastSeenAt: daysAgo(lastSeenDaysAgo),
    ...extra,
  };
}

function edge(src: string, dst: string, kind: BrainEdge['kind'] = 'RELATED_TO', weight = 1, metadata = {}): BrainEdge {
  return { src, dst, kind, weight, sourceId: null, metadata, createdAt: NOW };
}

/** A real brain, built through the projection rather than by hand. */
function realBrain() {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 22, 9, minute)).toISOString();
  const events: BrainEvent[] = [
    {
      id: 'e1', kind: 'question_asked', sourceKind: 'thread', sourceId: THREAD, dedupeKey: 'q1', createdAt: at(0),
      payload: { threadId: THREAD, messageId: 'm1', canonical: 'closures', fingerprint: 'fp', query: 'What is a closure?' },
    },
    {
      id: 'e2', kind: 'qa_distilled', sourceKind: 'thread', sourceId: THREAD, dedupeKey: 'd1', createdAt: at(1),
      payload: {
        threadId: THREAD, messageId: 'm1',
        extraction: {
          concepts: [{ label: 'Closures', okfPath: null }, { label: 'Lexical scope', okfPath: null }, { label: 'Garbage collection', okfPath: null }],
          insights: [{ text: 'A closure keeps its scope alive.', concepts: ['Closures'] }],
          mistakes: [{ text: 'Thinks closures copy values', concept: 'Closures' }],
        },
      },
    },
    {
      id: 'e3', kind: 'viva_score', sourceKind: 'assessment', sourceId: ASSESS, dedupeKey: 'v1', createdAt: at(5),
      payload: {
        assessmentId: ASSESS, conceptKey: 'closures', conceptLabel: 'Closures', attemptNumber: 1, mcqScore: 4, vivaScore: 18,
        rubricSnapshot: [], missedCriteria: [],
      },
    },
  ];
  return projectBrain(events);
}

describe('styleFor', () => {
  it('sizes and brightens a concept with its mastery', () => {
    const weak = styleFor(node('concept:a', 'concept', 3, { score: 0.1 }), NOW);
    const strong = styleFor(node('concept:b', 'concept', 3, { score: 0.9 }), NOW);
    expect(strong.radius).toBeGreaterThan(weak.radius);
    expect(strong.brightness).toBeGreaterThan(weak.brightness);
    expect(strong.tone).toBe('concept');
  });

  it('fades an insight with age and pulses anything touched in the last day', () => {
    const fresh = styleFor(node('insight:a', 'insight', 0.1), NOW);
    const old = styleFor(node('insight:b', 'insight', 60), NOW);
    expect(fresh.brightness).toBeGreaterThan(old.brightness);
    expect(fresh.recent).toBe(true);
    expect(old.recent).toBe(false);
  });

  it('grows a mistake with each recurrence', () => {
    const once = styleFor(node('mistake:a', 'mistake', 1, { metadata: { occurrences: 1 } }), NOW);
    const often = styleFor(node('mistake:b', 'mistake', 1, { metadata: { occurrences: 4 } }), NOW);
    expect(often.radius).toBeGreaterThan(once.radius);
    expect(often.brightness).toBeGreaterThan(once.brightness);
  });

  it('colours a checkpoint by its result', () => {
    expect(styleFor(node('checkpoint:a', 'checkpoint', 1, { metadata: { passed: true } }), NOW).tone).toBe('pass');
    expect(styleFor(node('checkpoint:b', 'checkpoint', 1, { metadata: { passed: false } }), NOW).tone).toBe('fail');
  });
});

describe('projectGraph', () => {
  it('keeps only nodes seen inside the window', () => {
    const nodes = [node('concept:new', 'concept', 5), node('concept:old', 'concept', 200)];
    const view = projectGraph(nodes, [], { now: NOW, windowDays: 90 });
    expect(view.nodes.map((n) => n.id)).toEqual(['concept:new']);
    expect(view.meta).toEqual({ total: 1, truncated: false, focus: null, brainSize: 2 });
  });

  it('reports an empty brain as empty, whatever the window', () => {
    expect(projectGraph([], [], { now: NOW, windowDays: 90 }).meta).toEqual({
      total: 0,
      truncated: false,
      focus: null,
      brainSize: 0,
    });
  });

  it('tells an empty window apart from an empty brain', () => {
    const view = projectGraph([node('concept:old', 'concept', 400)], [], { now: NOW, windowDays: 90 });
    expect(view.nodes).toEqual([]);
    expect(view.meta.brainSize).toBe(1);
  });

  it('shows all time when no window is given', () => {
    const nodes = [node('concept:new', 'concept', 5), node('concept:old', 'concept', 2000)];
    expect(projectGraph(nodes, [], { now: NOW }).nodes).toHaveLength(2);
  });

  it('caps nodes newest-first and says it did', () => {
    const nodes = Array.from({ length: 12 }, (_, i) => node(`concept:n${String(i).padStart(2, '0')}`, 'concept', i));
    const view = projectGraph(nodes, [], { now: NOW, maxNodes: 5 });
    expect(view.nodes.map((n) => n.id)).toEqual(['concept:n00', 'concept:n01', 'concept:n02', 'concept:n03', 'concept:n04']);
    expect(view.meta).toEqual({ total: 12, truncated: true, focus: null, brainSize: 12 });
  });

  it('defaults to the specification’s caps of 500 nodes and 1500 edges', () => {
    const nodes = Array.from({ length: 600 }, (_, i) => node(`concept:n${String(i).padStart(4, '0')}`, 'concept', i % 50));
    const edges = Array.from({ length: 2000 }, (_, i) =>
      edge(`concept:n${String(i % 500).padStart(4, '0')}`, `concept:n${String((i * 7 + 1) % 500).padStart(4, '0')}`, 'RELATED_TO', i % 9),
    );
    const view = projectGraph(nodes, edges, { now: NOW });
    expect(view.nodes.length).toBeLessThanOrEqual(GRAPH_LIMITS.maxNodes);
    expect(view.links.length).toBeLessThanOrEqual(GRAPH_LIMITS.maxEdges);
    expect(view.meta.truncated).toBe(true);
  });

  it('keeps the strongest links when it has to cut', () => {
    const nodes = [node('concept:a', 'concept', 1), node('concept:b', 'concept', 1), node('concept:c', 'concept', 1)];
    const edges = [edge('concept:a', 'concept:b', 'RELATED_TO', 1), edge('concept:a', 'concept:c', 'RELATED_TO', 9)];
    const view = projectGraph(nodes, edges, { now: NOW, maxEdges: 1 });
    expect(view.links).toEqual([{ source: 'concept:a', target: 'concept:c', kind: 'RELATED_TO', weight: 9 }]);
    expect(view.meta.truncated).toBe(true);
  });

  it('never returns a link to a node it left out', () => {
    const nodes = Array.from({ length: 10 }, (_, i) => node(`concept:n${i}`, 'concept', i));
    const edges = nodes.slice(1).map((n, i) => edge(`concept:n${i}`, n.id));
    const view = projectGraph(nodes, edges, { now: NOW, maxNodes: 4 });
    const ids = new Set(view.nodes.map((n) => n.id));
    for (const link of view.links) {
      expect(ids.has(link.source) && ids.has(link.target)).toBe(true);
    }
  });

  it('focuses on a node and its neighbourhood, to the depth asked', () => {
    // a — b — c — d, plus an unrelated e
    const nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => node(`concept:${id}`, 'concept', 1));
    const edges = [edge('concept:a', 'concept:b'), edge('concept:b', 'concept:c'), edge('concept:c', 'concept:d')];
    expect(projectGraph(nodes, edges, { now: NOW, focus: 'concept:a', depth: 1 }).nodes.map((n) => n.id)).toEqual([
      'concept:a',
      'concept:b',
    ]);
    expect(projectGraph(nodes, edges, { now: NOW, focus: 'concept:a', depth: 2 }).nodes.map((n) => n.id)).toEqual([
      'concept:a',
      'concept:b',
      'concept:c',
    ]);
  });

  it('keeps the focus node even when the cap would cut it', () => {
    const nodes = [node('concept:old', 'concept', 300), ...Array.from({ length: 5 }, (_, i) => node(`concept:n${i}`, 'concept', i))];
    const edges = nodes.slice(1).map((n) => edge('concept:old', n.id));
    const view = projectGraph(nodes, edges, { now: NOW, focus: 'concept:old', maxNodes: 2 });
    expect(view.nodes.map((n) => n.id)).toContain('concept:old');
    expect(view.meta.focus).toBe('concept:old');
  });

  it('ignores a focus the learner does not have', () => {
    const view = projectGraph([node('concept:a', 'concept', 1)], [], { now: NOW, focus: 'concept:nope' });
    expect(view.meta.focus).toBeNull();
    expect(view.nodes).toHaveLength(1);
  });

  it('is deterministic', () => {
    const { nodes, edges } = realBrain();
    const a = JSON.stringify(projectGraph(nodes, edges, { now: NOW, windowDays: 90 }));
    const b = JSON.stringify(projectGraph([...nodes].reverse(), [...edges].reverse(), { now: NOW, windowDays: 90 }));
    expect(a).toBe(b);
  });

  it('styles every node it returns', () => {
    const { nodes, edges } = realBrain();
    for (const n of projectGraph(nodes, edges, { now: NOW }).nodes) {
      expect(n.style.radius).toBeGreaterThan(0);
      expect(n.style.brightness).toBeGreaterThanOrEqual(0);
      expect(n.style.brightness).toBeLessThanOrEqual(1);
    }
  });
});

describe('sessionPath', () => {
  it('walks a session’s concepts in the order it first reached them, from edges or from links', () => {
    const { nodes, edges } = realBrain();
    const session = brainNodeId.threadSession(THREAD);
    const expected = ['concept:closures', 'concept:lexical-scope', 'concept:garbage-collection'];
    expect(sessionPath(session, edges)).toEqual(expected);
    expect(sessionPath(session, projectGraph(nodes, edges, { now: NOW }).links)).toEqual(expected);
  });

  it('is empty for a node that is not a session', () => {
    const { edges } = realBrain();
    expect(sessionPath('concept:closures', edges)).toEqual([]);
  });
});

describe('nodeDetail', () => {
  it('returns null for a node the learner does not have', () => {
    const { nodes, edges } = realBrain();
    expect(nodeDetail('concept:nope', nodes, edges)).toBeNull();
  });

  it('for a concept: where it came up, what it relates to, and every assessment', () => {
    const { nodes, edges } = realBrain();
    const detail = nodeDetail('concept:closures', nodes, edges);
    expect(detail?.sessions.map((s) => [s.source, s.sourceId])).toEqual([
      ['assessment', ASSESS],
      ['thread', THREAD],
    ]);
    expect(detail?.concepts.map((c) => c.id)).toEqual(['concept:garbage-collection', 'concept:lexical-scope']);
    expect(detail?.insights).toHaveLength(1);
    expect(detail?.mistakes).toEqual([expect.objectContaining({ occurrences: 1 })]);
    expect(detail?.assessments).toEqual([
      expect.objectContaining({ attemptNumber: 1, vivaScore: 18, mcqScore: 4, sessionId: brainNodeId.assessmentSession(ASSESS) }),
    ]);
    expect(detail?.path).toEqual([]);
  });

  it('for a session: the wire it drew, in order', () => {
    const { nodes, edges } = realBrain();
    const detail = nodeDetail(brainNodeId.threadSession(THREAD), nodes, edges);
    expect(detail?.path.map((p) => p.id)).toEqual(['concept:closures', 'concept:lexical-scope', 'concept:garbage-collection']);
  });
});
