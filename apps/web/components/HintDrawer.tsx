'use client';

import { useCallback, useEffect, useState } from 'react';

import { currentToken } from '../lib/supabase';

/**
 * Fetch a single hint tier from the API.
 *
 * Uses `currentToken` for auth, matching the pattern in lib/api.ts. Once
 * `@ai-edu/api-client` ships a `getHint` method on ApiClient, this helper
 * should be removed and callers should use `api.getHint(…)` instead.
 */
async function fetchHint(
  projectId: string,
  stepIndex: number,
  tier: number,
): Promise<string> {
  const token = await currentToken();
  const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
  const res = await fetch(
    `${baseUrl}/api/projects/${projectId}/steps/${stepIndex}/hints?tier=${tier}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    // The server enforces the same gate independently and explains itself in
    // the body — a bare status code here would leave a locked hint looking
    // like a broken one.
    const body = await res.json().catch(() => null);
    const message = typeof body?.message === 'string' ? body.message : null;
    throw new Error(message ?? `Failed to fetch hint (tier ${tier}): ${res.status}`);
  }
  const body = await res.json();
  return body.text as string;
}

/* ------------------------------------------------------------------ */

export interface HintDrawerProps {
  projectId: string;
  stepIndex: number;
  hintCount: number;
  attemptCount: number;
  startedAt: number | null;
  /** Tiers opened on an earlier visit. A spent hint stays spent. */
  openedTiers?: number[];
  /** Fired the first time a tier is opened, so it survives a reload. */
  onTierOpened?: (tier: number) => void;
}

const TIER_THRESHOLDS = [
  { attempts: 1, minutes: 5 },
  { attempts: 2, minutes: 10 },
  { attempts: 3, minutes: 15 },
] as const;

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
      if (!openedTiers.includes(tier)) onTierOpened?.(tier);

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
    [expanded, cache, projectId, stepIndex, openedTiers, onTierOpened],
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
  const tiers = TIER_THRESHOLDS.slice(0, hintCount);

  return (
    <section className="hints">
      <h3>Hints</h3>
      <div className="hint-list">
        {tiers.map((threshold, i) => {
          const tier = i + 1;
          const unlocked =
            attemptCount >= threshold.attempts ||
            elapsed >= threshold.minutes * 60_000;

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
                  <LockMessage
                    attemptsNeeded={threshold.attempts}
                    minutesNeeded={threshold.minutes}
                    attemptCount={attemptCount}
                    elapsed={elapsed}
                  />
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

/* ------------------------------------------------------------------ */

function LockMessage({
  attemptsNeeded,
  minutesNeeded,
  attemptCount,
  elapsed,
}: {
  attemptsNeeded: number;
  minutesNeeded: number;
  attemptCount: number;
  elapsed: number;
}) {
  const attemptsRemaining = attemptsNeeded - attemptCount;
  const msRemaining = minutesNeeded * 60_000 - elapsed;

  const parts: string[] = [];
  if (attemptsRemaining > 0) {
    parts.push(
      `${attemptsRemaining} more attempt${attemptsRemaining === 1 ? '' : 's'}`,
    );
  }
  if (msRemaining > 0) {
    const mins = Math.ceil(msRemaining / 60_000);
    parts.push(`${mins} min`);
  }

  return (
    <span className="hint-lock muted">
      Available after {parts.join(' or ')}
    </span>
  );
}
