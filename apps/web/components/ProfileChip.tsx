'use client';

import { useState } from 'react';
import { PROFILE_IDS } from '@ai-edu/core';
import type { ProfileId } from '@ai-edu/core';

import { profileLabel } from '../lib/stackBrief';

/**
 * What kind of software this is, as code detected it. Low confidence says so;
 * the learner can pick a runner-up or any other profile (§5).
 */
export interface ProfileChipProps {
  profile: ProfileId;
  confidence: number;
  alternatives: ProfileId[];
  busy: boolean;
  onChange: (profile: ProfileId) => void;
}

export function ProfileChip({ profile, confidence, alternatives, busy, onChange }: ProfileChipProps) {
  const [open, setOpen] = useState(false);
  const unsure = confidence < 0.6;
  return (
    <div className="scope-chip">
      <button className="chip" aria-pressed={open} aria-expanded={open} disabled={busy} onClick={() => setOpen(!open)}>
        {profileLabel(profile)}
        {unsure && <span className="muted"> · not sure</span>}
      </button>
      {open && (
        <div className="chips" role="group" aria-label="Which is closest?">
          {alternatives.map((id) => (
            <button key={id} className="chip" disabled={busy} onClick={() => (setOpen(false), onChange(id))}>
              {profileLabel(id)}
            </button>
          ))}
          <select
            className="chip-input"
            aria-label="Another kind of project"
            disabled={busy}
            value=""
            onChange={(e) => {
              if (!e.target.value) return;
              setOpen(false);
              onChange(e.target.value as ProfileId);
            }}
          >
            <option value="">Something else…</option>
            {PROFILE_IDS.filter((id) => id !== profile && !alternatives.includes(id)).map((id) => (
              <option key={id} value={id}>
                {profileLabel(id)}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
