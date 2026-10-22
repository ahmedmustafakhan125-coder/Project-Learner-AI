import type { BrainGraphLink, BrainGraphNode } from '@ai-edu/api-client';
import type { NodeTone } from '@ai-edu/core';

import {
  createLayout,
  fitTransform,
  hitTest,
  neighboursOf,
  pointAlong,
  settled,
  toScreen,
  UPDATE_WARM_TICKS,
  WARM_TICKS,
  warm,
  zoomAt,
} from './brainLayout';
import type { Layout, LayoutNode, ViewTransform } from './brainLayout';

/**
 * Draws the brain on a canvas.
 *
 * Imperative on purpose. A force layout moves every node on every frame, and
 * pushing that through React state would re-render the tree sixty times a
 * second for no benefit. The React component owns the data and the selection;
 * this owns the pixels, and decides nothing about what the graph means — every
 * size, tone and brightness arrives precomputed in `node.style`.
 *
 * Frames run only while something is moving: the layout settling, a session's
 * wire animating, or a recently touched node pulsing. A settled, quiet graph
 * draws once and stops.
 */

export interface RendererView {
  selectedId: string | null;
  /** Ordered ids the selected session's wire runs through, session first. */
  wire: string[];
  hoverEnabled: boolean;
}

interface Palette {
  tones: Record<NodeTone, string>;
  links: Record<BrainGraphLink['kind'], string>;
  wire: string;
  label: string;
  labelHalo: string;
  selection: string;
}

/** Read from CSS custom properties so the canvas follows the stylesheet. */
function readPalette(element: Element): Palette {
  const css = getComputedStyle(element);
  const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const concept = read('--brain-concept', '#cbd5e1');
  const insight = read('--brain-insight', '#2dd4bf');
  const mistake = read('--brain-mistake', '#fbbf24');
  const session = read('--brain-session', '#64748b');
  const project = read('--brain-project', '#38bdf8');
  const pass = read('--brain-pass', '#34d399');
  const fail = read('--brain-fail', '#f87171');
  const wire = read('--brain-wire', '#7dd3fc');
  return {
    tones: { concept, insight, mistake, session, project, pass, fail },
    links: {
      ACTIVATED: wire,
      RELATED_TO: concept,
      PRODUCED: insight,
      OCCURRED_IN: mistake,
      CONTAINS: project,
      ASSESSED: pass,
      DUPLICATE_OF: read('--brain-duplicate', '#c4b5fd'),
    },
    wire,
    label: read('--brain-label', '#e2e8f0'),
    labelHalo: read('--brain-label-halo', 'rgba(8, 15, 33, 0.85)'),
    selection: read('--brain-selection', '#ffffff'),
  };
}

const LINK_ALPHA: Record<BrainGraphLink['kind'], number> = {
  ACTIVATED: 0.32,
  RELATED_TO: 0.22,
  PRODUCED: 0.3,
  OCCURRED_IN: 0.4,
  CONTAINS: 0.35,
  ASSESSED: 0.55,
  DUPLICATE_OF: 0.5,
};

/** A drag that moves less than this is a click. */
const CLICK_TOLERANCE_PX = 4;
const LABEL_CHARS = 28;

function clipLabel(text: string): string {
  return text.length <= LABEL_CHARS ? text : `${text.slice(0, LABEL_CHARS - 1)}…`;
}

/** A stable 0..1 phase per node, so pulses do not all beat in unison. */
function phaseOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (h >>> 0) / 4294967296;
}

export class BrainRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly palette: Palette;
  private readonly resizeObserver: ResizeObserver;
  private readonly reducedMotion: boolean;

  private layout: Layout | null = null;
  private neighbours = new Map<string, Set<string>>();
  private transform: ViewTransform = { k: 1, x: 0, y: 0 };
  /**
   * True until the learner zooms or pans. While it holds, the view refits on
   * every frame the layout is still settling — the graph keeps contracting
   * after the first frame, and a fit taken once at the start leaves it
   * huddled in the middle of the canvas.
   */
  private autoFit = true;
  private width = 0;
  private height = 0;
  private dpr = 1;

  private view: RendererView = { selectedId: null, wire: [], hoverEnabled: true };
  private hovered: string | null = null;
  private drag: { startX: number; startY: number; fromX: number; fromY: number; moved: boolean } | null = null;
  private frame: number | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private onNodeClick: (id: string | null) => void,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available.');
    this.ctx = ctx;
    this.palette = readPalette(canvas);
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);

    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('keydown', this.onKeyDown);

    this.resize();
  }

  /* ---------------- inputs from React ---------------- */

  setGraph(nodes: readonly BrainGraphNode[], links: readonly BrainGraphLink[]): void {
    const previous = new Map(this.layout?.nodes.map((n) => [n.id, { x: n.x, y: n.y }]) ?? []);
    this.layout?.simulation.stop();
    this.layout = createLayout(nodes, links, previous);
    warm(this.layout, previous.size > 0 ? UPDATE_WARM_TICKS : WARM_TICKS);
    this.neighbours = neighboursOf(this.layout);
    if (this.hovered && !this.layout.byId.has(this.hovered)) this.hovered = null;
    // A graph new to the screen is fitted; a refetch under a learner who has
    // zoomed in on something leaves their view alone.
    if (previous.size === 0) this.autoFit = true;
    this.fitIfNeeded();
    this.request();
  }

  setView(view: RendererView): void {
    this.view = view;
    if (!view.hoverEnabled) this.hovered = null;
    this.request();
  }

  setOnNodeClick(handler: (id: string | null) => void): void {
    this.onNodeClick = handler;
  }

  /** Re-centre the whole graph in view, and keep it centred while it settles. */
  fit(): void {
    this.autoFit = true;
    this.fitIfNeeded();
    this.request();
  }

  destroy(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.layout?.simulation.stop();
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('keydown', this.onKeyDown);
  }

  /* ---------------- sizing ---------------- */

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (rect.width === this.width && rect.height === this.height && dpr === this.dpr) return;
    this.width = rect.width;
    this.height = rect.height;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.fitIfNeeded();
    this.request();
  }

  private fitIfNeeded(): void {
    if (!this.autoFit || !this.layout || this.width === 0 || this.height === 0) return;
    this.transform = fitTransform(this.layout, this.width, this.height);
  }

  /* ---------------- frame loop ---------------- */

  private request(): void {
    if (this.frame === null) this.frame = requestAnimationFrame(this.tick);
  }

  private readonly tick = (time: number): void => {
    this.frame = null;
    if (this.layout && !settled(this.layout)) {
      this.layout.simulation.tick();
      this.fitIfNeeded();
    }
    this.draw(time);
    if (this.animating()) this.request();
  };

  private animating(): boolean {
    if (!this.layout) return false;
    if (!settled(this.layout)) return true;
    if (this.reducedMotion) return false;
    return this.view.wire.length > 1 || this.layout.nodes.some((n) => n.node.style.recent);
  }

  /* ---------------- drawing ---------------- */

  private draw(time: number): void {
    const { ctx, palette, transform: t } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    const layout = this.layout;
    if (!layout) return;

    // What to keep bright: the hovered node and its neighbours, else the
    // selected one and its neighbours, else everything.
    const anchor = this.hovered ?? this.view.selectedId;
    const lit = anchor ? new Set([anchor, ...(this.neighbours.get(anchor) ?? [])]) : null;
    const wireIds = new Set(this.view.wire);

    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);

    // Links
    for (const link of layout.links) {
      const s = link.source as LayoutNode;
      const d = link.target as LayoutNode;
      const dim = lit !== null && !(lit.has(s.id) && lit.has(d.id));
      ctx.globalAlpha = dim ? 0.05 : LINK_ALPHA[link.kind];
      ctx.strokeStyle = palette.links[link.kind];
      ctx.lineWidth = (0.6 + Math.min(2.4, Math.log2(1 + link.weight))) / Math.sqrt(t.k);
      ctx.setLineDash(link.kind === 'DUPLICATE_OF' ? [4 / t.k, 4 / t.k] : []);
      ctx.beginPath();
      ctx.moveTo(s.x ?? 0, s.y ?? 0);
      ctx.lineTo(d.x ?? 0, d.y ?? 0);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // The selected session's wire, animated along its path
    const wirePoints = this.view.wire
      .map((id) => layout.byId.get(id))
      .filter((n): n is LayoutNode => Boolean(n))
      .map((n) => ({ x: n.x ?? 0, y: n.y ?? 0 }));
    if (wirePoints.length > 1) {
      ctx.save();
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = palette.wire;
      ctx.shadowColor = palette.wire;
      ctx.shadowBlur = 12;
      ctx.lineWidth = 2.6 / Math.sqrt(t.k);
      ctx.lineJoin = 'round';
      ctx.setLineDash([7 / t.k, 6 / t.k]);
      ctx.lineDashOffset = this.reducedMotion ? 0 : -(time / 40) / t.k;
      ctx.beginPath();
      wirePoints.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
      if (!this.reducedMotion) {
        const pulse = pointAlong(wirePoints, (time % 2600) / 2600);
        if (pulse) {
          ctx.setLineDash([]);
          ctx.fillStyle = palette.wire;
          ctx.beginPath();
          ctx.arc(pulse.x, pulse.y, 3.5 / Math.sqrt(t.k), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // Nodes
    for (const n of layout.nodes) {
      const { style } = n.node;
      const colour = palette.tones[style.tone];
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      const dim = lit !== null && !lit.has(n.id) && !wireIds.has(n.id);

      ctx.globalAlpha = dim ? 0.14 : style.brightness;
      ctx.fillStyle = colour;
      // A strong concept glows; the glow is the visible half of "mastery".
      const glow = !dim && style.tone === 'concept' && style.brightness > 0.7;
      ctx.shadowColor = glow ? colour : 'transparent';
      ctx.shadowBlur = glow ? 16 * style.brightness : 0;
      ctx.beginPath();
      ctx.arc(x, y, n.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      if (style.recent && !this.reducedMotion && !dim) {
        const phase = (time / 1400 + phaseOf(n.id)) % 1;
        ctx.globalAlpha = (1 - phase) * 0.55;
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1.2 / t.k;
        ctx.beginPath();
        ctx.arc(x, y, n.radius + 2 + phase * 9, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (n.id === this.view.selectedId || n.id === this.hovered) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = palette.selection;
        ctx.lineWidth = (n.id === this.view.selectedId ? 2 : 1.2) / t.k;
        ctx.beginPath();
        ctx.arc(x, y, n.radius + 3 / t.k, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();

    // Labels, in screen space so they stay readable at every zoom
    ctx.globalAlpha = 1;
    ctx.font = '500 11.5px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    // Most important first, and a label that would sit on top of one already
    // drawn is skipped: a crowded graph shows fewer names, never a pile of
    // unreadable ones. The selection and its wire always win.
    const rank = (n: LayoutNode) =>
      n.id === this.view.selectedId ? 0 : n.id === this.hovered ? 1 : wireIds.has(n.id) ? 2 : 3;
    const candidates = layout.nodes
      .filter((n) => this.shouldLabel(n, lit, wireIds))
      .sort((a, b) => rank(a) - rank(b) || b.radius - a.radius || (a.id < b.id ? -1 : 1));
    const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
    const LABEL_HEIGHT = 14;
    for (const n of candidates) {
      const p = toScreen(t, n.x ?? 0, n.y ?? 0);
      if (p.x < -50 || p.y < -20 || p.x > this.width + 50 || p.y > this.height + 20) continue;
      const text = clipLabel(n.node.label);
      const x = p.x + n.radius * t.k + 5;
      const box = { x, y: p.y - LABEL_HEIGHT / 2, w: ctx.measureText(text).width, h: LABEL_HEIGHT };
      const overlaps = placed.some(
        (o) => box.x < o.x + o.w + 4 && o.x < box.x + box.w + 4 && box.y < o.y + o.h && o.y < box.y + box.h,
      );
      if (overlaps && rank(n) > 2) continue;
      placed.push(box);
      ctx.lineWidth = 3;
      ctx.strokeStyle = palette.labelHalo;
      ctx.strokeText(text, x, p.y);
      ctx.fillStyle = palette.label;
      ctx.fillText(text, x, p.y);
    }
  }

  private shouldLabel(n: LayoutNode, lit: Set<string> | null, wire: Set<string>): boolean {
    if (n.id === this.view.selectedId || n.id === this.hovered) return true;
    if (wire.has(n.id)) return true;
    if (lit) return lit.has(n.id) && n.node.kind !== 'session';
    if (n.node.kind === 'project') return true;
    if (n.node.kind !== 'concept') return false;
    return n.radius * this.transform.k >= 9 || this.transform.k >= 1.6;
  }

  /* ---------------- input ---------------- */

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.autoFit = false;
    this.transform = zoomAt(this.transform, event.offsetX, event.offsetY, Math.exp(-event.deltaY * 0.0015));
    this.request();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.canvas.setPointerCapture?.(event.pointerId);
    this.drag = {
      startX: event.clientX,
      startY: event.clientY,
      fromX: this.transform.x,
      fromY: this.transform.y,
      moved: false,
    };
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.drag) {
      const dx = event.clientX - this.drag.startX;
      const dy = event.clientY - this.drag.startY;
      if (!this.drag.moved && Math.hypot(dx, dy) > CLICK_TOLERANCE_PX) this.drag.moved = true;
      if (this.drag.moved) {
        this.autoFit = false;
        this.transform = { ...this.transform, x: this.drag.fromX + dx, y: this.drag.fromY + dy };
        this.canvas.style.cursor = 'grabbing';
        this.request();
      }
      return;
    }
    if (!this.layout) return;
    const hit = hitTest(this.layout, this.transform, event.offsetX, event.offsetY);
    this.canvas.style.cursor = hit ? 'pointer' : 'grab';
    if (!this.view.hoverEnabled) return;
    const id = hit?.id ?? null;
    if (id !== this.hovered) {
      this.hovered = id;
      this.request();
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const drag = this.drag;
    this.drag = null;
    this.canvas.style.cursor = 'grab';
    if (!drag || drag.moved || !this.layout) return;
    const hit = hitTest(this.layout, this.transform, event.offsetX, event.offsetY);
    this.onNodeClick(hit?.id ?? null);
  };

  private readonly onPointerLeave = (): void => {
    if (this.hovered !== null) {
      this.hovered = null;
      this.request();
    }
  };

  /** Zoom, pan and clear selection without a pointer. */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const step = 60;
    const centre = { x: this.width / 2, y: this.height / 2 };
    switch (event.key) {
      case '+':
      case '=':
        this.transform = zoomAt(this.transform, centre.x, centre.y, 1.25);
        break;
      case '-':
        this.transform = zoomAt(this.transform, centre.x, centre.y, 0.8);
        break;
      case '0':
        this.fit();
        return;
      case 'ArrowLeft':
        this.transform = { ...this.transform, x: this.transform.x + step };
        break;
      case 'ArrowRight':
        this.transform = { ...this.transform, x: this.transform.x - step };
        break;
      case 'ArrowUp':
        this.transform = { ...this.transform, y: this.transform.y + step };
        break;
      case 'ArrowDown':
        this.transform = { ...this.transform, y: this.transform.y - step };
        break;
      case 'Escape':
        this.onNodeClick(null);
        return;
      default:
        return;
    }
    event.preventDefault();
    this.autoFit = false;
    this.request();
  };
}

