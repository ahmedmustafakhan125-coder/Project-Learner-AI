/**
 * Presidio's AnonymizerEngine with the "replace" operator and its default
 * conflict strategy, MERGE_SIMILAR_OR_CONTAINED.
 *
 * Overlapping detections of one type merge into a single span. Then any
 * detection inside another, or on the same span with no higher score, is
 * dropped. Same-type detections separated only by spaces merge too. Partial
 * overlaps of different types survive, and replacing right to left trims the
 * left one where they meet, which is Presidio's behaviour as well.
 */

import type { Detection, EntityType } from './types.js';

function intersection(a: Detection, b: Detection): number {
  if (a.end < b.start || b.end < a.start) return 0;
  return Math.min(a.end, b.end) - Math.max(a.start, b.start);
}

/** Presidio's `has_conflict`: `self` loses to `other`. */
function losesTo(self: Detection, other: Detection): boolean {
  if (self.start === other.start && self.end === other.end) return self.score <= other.score;
  return other.start <= self.start && other.end >= self.end;
}

function without<T>(list: T[], item: T): T[] {
  const index = list.indexOf(item);
  return index < 0 ? list : [...list.slice(0, index), ...list.slice(index + 1)];
}

function resolveConflicts(detections: Detection[]): Detection[] {
  // Each detection is compared with those not yet processed and those kept
  // so far, in that order, as Presidio's list juggling has it.
  let others = [...detections];
  const distinct: Detection[] = [];
  for (const detection of detections) {
    others = without(others, detection);
    const overlapping = others.find((o) => o.type === detection.type && intersection(detection, o) > 0);
    if (overlapping) {
      overlapping.start = Math.min(detection.start, overlapping.start);
      overlapping.end = Math.max(detection.end, overlapping.end);
      overlapping.score = Math.max(detection.score, overlapping.score);
    } else {
      others.push(detection);
      distinct.push(detection);
    }
  }

  let rest = [...distinct];
  const unique: Detection[] = [];
  for (const detection of distinct) {
    rest = without(rest, detection);
    if (!rest.some((other) => losesTo(detection, other))) {
      rest.push(detection);
      unique.push(detection);
    }
  }
  return unique;
}

function mergeSpaceSeparated(text: string, detections: Detection[]): Detection[] {
  let merged: Detection[] = [];
  let previous: Detection | null = null;
  for (const detection of detections) {
    if (previous && previous.type === detection.type && /^ +$/.test(text.slice(previous.end, detection.start))) {
      merged = without(merged, previous);
      detection.start = previous.start;
    }
    merged.push(detection);
    previous = detection;
  }
  return merged;
}

export function anonymize(text: string, detections: Detection[], placeholders: Record<EntityType, string>): string {
  const entities = mergeSpaceSeparated(text, resolveConflicts(detections));
  // Right to left, so the offsets still to come are unaffected.
  const ordered = [...entities].sort((a, b) => b.start - a.start || b.end - a.end);
  let output = text;
  let lastReplaced = text.length;
  for (const entity of ordered) {
    const end = Math.min(entity.end, lastReplaced);
    output = output.slice(0, entity.start) + placeholders[entity.type] + output.slice(end);
    lastReplaced = entity.start;
  }
  return output;
}
