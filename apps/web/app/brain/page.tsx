'use client';

import { AuthGate } from '../../components/AuthGate';
import { BrainView } from '../../components/brain/BrainView';

/**
 * The learner's brain: a graph of every concept they have worked on, wired by
 * the sessions that connected them. Its own route, so none of its code loads
 * on the pages where questions are asked and code is written.
 */
export default function BrainPage() {
  return (
    <AuthGate>
      <BrainView />
    </AuthGate>
  );
}
