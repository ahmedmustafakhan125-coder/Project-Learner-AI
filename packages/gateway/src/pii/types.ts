export type EntityType =
  | 'PERSON'
  | 'EMAIL_ADDRESS'
  | 'PHONE_NUMBER'
  | 'CREDIT_CARD'
  | 'IBAN_CODE'
  | 'US_SSN'
  | 'API_KEY'
  | 'CNIC'
  | 'STUDENT_ID';

/**
 * One detection: Presidio's RecognizerResult. Offsets are UTF-16 indices.
 *
 * Deliberately mutable. Context scoring raises `score`, and the anonymizer
 * widens spans when it merges overlapping detections, both in place, as
 * Presidio does; the entities the gateway reports are read afterwards, so
 * they show the merged spans just as the Python gateway's did.
 */
export interface Detection {
  type: EntityType;
  start: number;
  end: number;
  score: number;
  recognizer: Recognizer;
}

export interface Recognizer {
  name: string;
  /** Words that raise a detection's score when they occur near it. */
  context: string[];
  analyze(text: string): Detection[];
}

/**
 * Presidio's `remove_duplicates`: drops zero scores, and any detection inside
 * a higher-ranked one of the same type. Ranked by score, then position, then
 * length; ties beyond that are broken by type and recognizer, so the result
 * never depends on input order.
 */
export function removeDuplicates(detections: Detection[]): Detection[] {
  const ranked = [...detections].sort(
    (a, b) =>
      b.score - a.score ||
      a.start - b.start ||
      b.end - b.start - (a.end - a.start) ||
      compare(a.type, b.type) ||
      compare(a.recognizer.name, b.recognizer.name),
  );
  const kept: Detection[] = [];
  for (const detection of ranked) {
    if (detection.score === 0) continue;
    const covered = kept.some(
      (k) => k.type === detection.type && detection.start >= k.start && detection.end <= k.end,
    );
    if (!covered) kept.push(detection);
  }
  return kept;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
