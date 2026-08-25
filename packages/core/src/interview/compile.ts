import type { QueryIntent } from '../schemas/common.js';
import type { AttachmentRef } from '../schemas/common.js';
import type { CompiledQuery, Slots } from '../schemas/interview.js';
import { scoreSufficiency, slotDef, slotsFor } from './slots.js';

/**
 * Turn the interview's resolved state into the single artifact that reaches the
 * model. Nothing downstream ever sees the raw query on its own.
 *
 * The rendered text is deterministic — same slots in, same bytes out. That
 * matters beyond tidiness: this block sits inside the fan-out's prompt, and
 * unstable rendering would produce a different cache key on every request.
 */

export interface CompileInput {
  intent: QueryIntent;
  rawQuery: string;
  slots: Slots;
  attachments?: AttachmentRef[];
  /** True when the learner pressed Skip rather than answering. */
  skipped?: boolean;
}

export function compileQuery(input: CompileInput): CompiledQuery {
  const { intent, rawQuery, slots, attachments = [], skipped = false } = input;

  const lines: string[] = [];
  lines.push('<learner_question>');
  lines.push(rawQuery.trim());
  lines.push('</learner_question>');

  // Catalogue order, not object-key order — object key order depends on
  // insertion sequence and would make the rendered bytes vary between requests
  // that resolved the same slots in a different order.
  const rendered = slotsFor(intent)
    .map((def) => {
      const slot = slots[def.key];
      if (!slot?.value?.trim()) return null;
      return `- ${def.label}: ${slot.value.trim()}`;
    })
    .filter((line): line is string => line !== null);

  if (rendered.length) {
    lines.push('');
    lines.push('<context>');
    lines.push(...rendered);
    lines.push('</context>');
  }

  if (attachments.length) {
    lines.push('');
    lines.push('<attachments>');
    for (const file of attachments) {
      lines.push(`- ${file.filename} (${file.mimeType}, ${file.sizeBytes} bytes)`);
    }
    lines.push('</attachments>');
  }

  const { missing } = scoreSufficiency(intent, slots);
  if (skipped && missing.length) {
    lines.push('');
    lines.push('<unknown>');
    lines.push(
      'The learner chose to skip these, so do not assume a value — if the answer ' +
        'genuinely depends on one, say so briefly and give the most useful general answer:',
    );
    for (const key of missing) {
      lines.push(`- ${slotDef(intent, key)?.label ?? key}`);
    }
    lines.push('</unknown>');
  }

  return {
    intent,
    originalQuery: rawQuery,
    text: lines.join('\n'),
    slots,
    attachments,
    partial: skipped && missing.length > 0,
  };
}

/**
 * Merge answers back into slots. Answers always win — the learner has just
 * told us directly, which outranks anything inferred.
 */
export function applyAnswers(slots: Slots, answers: Record<string, string>): Slots {
  const merged: Slots = { ...slots };
  for (const [key, value] of Object.entries(answers)) {
    const trimmed = value?.trim();
    if (trimmed) merged[key] = { value: trimmed, source: 'answer' };
  }
  return merged;
}

/**
 * Slots stable enough to carry into future sessions, so returning learners get
 * asked progressively less.
 *
 * Only durable facts qualify. A topic or an error message is true of one query;
 * a skill level is true of the person.
 */
const DURABLE_SLOTS = new Set(['skill_level', 'goal', 'constraints']);

export function extractDurableSlots(slots: Slots): Record<string, string> {
  const durable: Record<string, string> = {};
  for (const [key, slot] of Object.entries(slots)) {
    // Only keep what the learner stated themselves. Persisting an inferred
    // value would let one wrong guess harden into a permanent fact.
    if (DURABLE_SLOTS.has(key) && (slot.source === 'answer' || slot.source === 'query')) {
      durable[key] = slot.value;
    }
  }
  return durable;
}
