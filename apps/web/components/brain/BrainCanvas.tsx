'use client';

import { useEffect, useRef } from 'react';
import type { BrainGraphLink, BrainGraphNode } from '@ai-edu/api-client';

import { BrainRenderer } from '../../lib/brainRenderer';

/**
 * The canvas, and nothing else.
 *
 * Receives nodes and links already chosen and styled, reports clicks, and owns
 * no fetching, filtering or mastery logic. Loaded with `ssr: false` from
 * BrainView, so the force layout's code never reaches a page that does not
 * show the brain.
 */

export interface BrainCanvasProps {
  nodes: BrainGraphNode[];
  links: BrainGraphLink[];
  selectedId: string | null;
  /** Ordered ids the selected session's wire runs through, session first. */
  wire: string[];
  hoverEnabled: boolean;
  onNodeClick: (id: string | null) => void;
  /** What a screen reader hears for the canvas as a whole. */
  description: string;
}

export default function BrainCanvas({
  nodes,
  links,
  selectedId,
  wire,
  hoverEnabled,
  onNodeClick,
  description,
}: BrainCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<BrainRenderer | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new BrainRenderer(canvas, onNodeClick);
    rendererRef.current = renderer;
    return () => {
      renderer.destroy();
      rendererRef.current = null;
    };
    // The renderer lives as long as the canvas; later click handlers arrive
    // through `setOnNodeClick` below rather than by rebuilding it.
  }, []);

  useEffect(() => {
    rendererRef.current?.setOnNodeClick(onNodeClick);
  }, [onNodeClick]);

  useEffect(() => {
    rendererRef.current?.setGraph(nodes, links);
  }, [nodes, links]);

  useEffect(() => {
    rendererRef.current?.setView({ selectedId, wire, hoverEnabled });
  }, [selectedId, wire, hoverEnabled]);

  return (
    <div className="brain-canvas-wrap">
      <canvas
        ref={canvasRef}
        className="brain-canvas"
        role="img"
        aria-label={description}
        tabIndex={0}
      />
      <div className="brain-canvas-hint" aria-hidden="true">
        Scroll to zoom · drag to pan · click a dot
      </div>
      <button type="button" className="brain-fit" onClick={() => rendererRef.current?.fit()}>
        Fit
      </button>
    </div>
  );
}
