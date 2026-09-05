'use client';

import { useCallback, useEffect, useState } from 'react';

import { describeHintLock, hintTierState } from '@ai-edu/core';

import { api } from '../lib/api';

/**
 * Fetch a single hint tier from the API using the unified ApiClient.
 */
async function fetchHint(
  projectId: string,
  stepIndex: number,
  tier: number,
): Promise<string> {
  const res = await api.getHint(projectId, stepIndex, tier);
  return res.text;
}

/* ------------------------------------------------------------------ */

export interface HintDrawerProps {
  projectId: string;
  stepIndex: number;
  hintCount: number;
  attemptCount: number;
  startedAt: number | null;
  /**
   * True once this step's checkpoint has passed.
   *
   * Opens the whole ladder. The gate exists so a learner cannot skip the
   * thinking by reading the answer first; once they have solved it that reason
   * is spent, and the tier-3 hint is often the clearest account of the
   * technique in the entire step. The server applies the same rule, so this is
   * the visible half rather than the enforcing one.
   */
  passed?: boolean;
  /** Tiers opened on an earlier visit. A spent hint stays spent. */
  openedTiers?: number[];
  /** Fired the first time a tier is opened, so it survives a reload. */
  onTierOpened?: (tier: number) => void;
}


/**
 * Progressive hint drawer.
 *
 * Hints are gated by attempt count or elapsed time — whichever comes first.
 * Each tier is fetched lazily on first expand and cached in state so the
 * learner can collapse/expand freely after the initial load.
 */
export function HintDrawer({
  projectId,
  stepIndex,
  hintCount,
  attemptCount,
  startedAt,
  passed = false,
  openedTiers = [],
  onTierOpened,
}: HintDrawerProps) {
  // A hint the learner has already read reopens read. Collapsing it back to
  // "locked" on every visit would ask them to spend it twice.
  const [expanded, setExpanded] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(openedTiers.map((tier) => [tier, true])),
  );
  const [cache, setCache] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState<Record<number, boolean>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});

  // Re-render every 30 s so the "available in X minutes" text stays current.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const toggle = useCallback(
    async (tier: number) => {
      // Already open → just collapse.
      if (expanded[tier]) {
        setExpanded((prev) => ({ ...prev, [tier]: false }));
        return;
      }

      setExpanded((prev) => ({ ...prev, [tier]: true }));
      /*
       * A hint read after passing is not help, so it is not spent.
       *
       * `hints_opened` is what an attempt's `hints_used` is derived from, and
       * that feeds the pacing model. Recording a hint the learner opened while
       * reading back over work they had already finished would report a
       * struggle that did not happen, and the next step would be scaffolded
       * down for it.
       */
      if (!passed && !openedTiers.includes(tier)) onTierOpened?.(tier);

      // Already cached — nothing to fetch.
      if (cache[tier] !== undefined) return;

      setLoading((prev) => ({ ...prev, [tier]: true }));
      try {
        const text = await fetchHint(projectId, stepIndex, tier);
        setCache((prev) => ({ ...prev, [tier]: text }));
      } catch (err) {
        setErrors((prev) => ({
          ...prev,
          [tier]: err instanceof Error ? err.message : 'Something went wrong.',
        }));
      } finally {
        setLoading((prev) => ({ ...prev, [tier]: false }));
      }
    },
    [expanded, cache, projectId, stepIndex, passed, openedTiers, onTierOpened],
  );

  // Tiers carried over from a previous visit are open but empty — their text
  // was never in this page's memory. Fetch it once so they read as they left.
  useEffect(() => {
    for (const tier of openedTiers) {
      if (cache[tier] !== undefined || loading[tier]) continue;
      setLoading((prev) => ({ ...prev, [tier]: true }));
      fetchHint(projectId, stepIndex, tier)
        .then((text) => setCache((prev) => ({ ...prev, [tier]: text })))
        .catch((err: unknown) =>
          setErrors((prev) => ({
            ...prev,
            [tier]: err instanceof Error ? err.message : 'Something went wrong.',
          })),
        )
        .finally(() => setLoading((prev) => ({ ...prev, [tier]: false })));
    }
    // Keyed on the step alone: this is the mount-time restore, and `toggle`
    // owns every tier opened after it.
  }, [projectId, stepIndex]);

  // After the hooks, never before: a conditional return above them changes the
  // hook order the first time `hintCount` goes from 0 to non-zero, and React
  // throws rather than rendering.
  if (hintCount === 0) return null;

  const elapsed = startedAt ? Date.now() - startedAt : 0;
  const tiers = Array.from({ length: hintCount }, (_, i) => i);

  return (
    <section className="hints">
      <h3>Hints</h3>
      {passed && (
        <p className="muted hints-unlocked">
          All open now that you have passed - the later ones explain the technique in full.
        </p>
      )}
      <div className="hint-list">
        {tiers.map((_, i) => {
          const tier = i + 1;
          // The same function the server gates on, so the panel cannot promise
          // a hint the request will then be refused.
          const state = hintTierState({ tier, attemptCount, elapsedMs: elapsed, passed });
          const unlocked = state.unlocked;

          return (
            <div key={tier} className={`hint-tier ${unlocked ? 'unlocked' : 'locked'}`}>
              <button
                type="button"
                className="hint-header"
                disabled={!unlocked}
                aria-expanded={!!expanded[tier]}
                onClick={() => toggle(tier)}
              >
                <span className="hint-label">Hint {tier}</span>
                {unlocked ? (
                  <span className={`hint-chevron ${expanded[tier] ? 'open' : ''}`}>
                    &#8250;
                  </span>
                ) : (
                  <span className="hint-lock muted">{describeHintLock(state)}</span>
                )}
              </button>

              {unlocked && expanded[tier] && (
                <div className="hint-body">
                  {loading[tier] && (
                    <span className="skeleton">Loading hint…</span>
                  )}
                  {errors[tier] && (
                    <span className="muted">{errors[tier]}</span>
                  )}
                  {cache[tier] !== undefined && <span>{cache[tier]}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
