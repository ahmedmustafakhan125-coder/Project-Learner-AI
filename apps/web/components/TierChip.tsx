'use client';

import type { ComplexityTier } from '@ai-edu/core';

import { TIER_LABEL } from '../lib/stackBrief';

/**
 * How big the project is, with every reason that moved it. The learner may
 * move it one step either way from what was scored (§5).
 */
export interface TierChipProps {
  tier: ComplexityTier;
  reasons: string[];
  overTime: boolean;
  busy: boolean;
  onStep: (step: -1 | 1) => void;
}

export function TierChip({ tier, reasons, overTime, busy, onStep }: TierChipProps) {
  return (
    <div className="scope-chip">
      <details className="tier-chip">
        <summary className="chip">
          {tier} · {TIER_LABEL[tier]}
        </summary>
        <ul className="tight muted">
          {reasons.length ? reasons.map((r) => <li key={r}>{r}</li>) : <li>Nothing in your request made it bigger.</li>}
        </ul>
      </details>
      <button className="btn ghost" disabled={busy || tier === 'T1'} onClick={() => onStep(-1)} aria-label="Smaller project">
        Smaller
      </button>
      <button className="btn ghost" disabled={busy || tier === 'T5'} onClick={() => onStep(1)} aria-label="Bigger project">
        Bigger
      </button>
      {overTime && (
        <p className="notice warn">
          This needs more time than you have. Milestone 1 is planned as a project on its own, and the rest follow.
        </p>
      )}
    </div>
  );
}
