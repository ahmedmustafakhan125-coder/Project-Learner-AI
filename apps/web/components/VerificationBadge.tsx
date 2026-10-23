import type { Verification } from '@ai-edu/core';

import { VERIFICATION_LABEL } from '../lib/stackBrief';

/** Which check a layer's steps get, said before the learner approves (§8). */
export function VerificationBadge({ verification }: { verification: Verification }) {
  const { label, detail } = VERIFICATION_LABEL[verification];
  return (
    <span className={`verify-badge verify-${verification}`} title={detail}>
      {label}
    </span>
  );
}
