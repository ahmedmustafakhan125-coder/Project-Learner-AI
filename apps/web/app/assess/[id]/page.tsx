'use client';

import { useParams } from 'next/navigation';

import { AuthGate } from '../../../components/AuthGate';
import { AssessmentRunner } from '../../../components/assessment/AssessmentRunner';

/** One assessment sitting: the multiple-choice gate, the viva, the report. */
export default function AssessPage() {
  const params = useParams<{ id: string }>();
  return (
    <AuthGate>
      <AssessmentRunner id={params.id} />
    </AuthGate>
  );
}
