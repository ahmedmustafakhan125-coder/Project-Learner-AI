import { describe, expect, it } from 'vitest';

import { EXTRACTION_LIMITS, EXTRACTION_PROMPT, buildExtractionRequest, normaliseExtraction } from '../src/brain/extract.js';
import { Extraction } from '../src/brain/types.js';

const library = [
  { title: 'Row-level security', path: '/concepts/row-level-security.md' },
  { title: 'Closures', path: '/concepts/closures.md' },
];

const input = {
  modelId: 'gemini-3.7-flash',
  question: '<learner_question>\nwhat is a closure?\n</learner_question>',
  conceptsAnswer: '- **Closures**: a function plus the scope it was defined in.',
  library,
};

describe('the extraction request', () => {
  it('sends the locked prompt as a cached system block, byte-identical for every learner', () => {
    const a = buildExtractionRequest(input);
    const b = buildExtractionRequest({ ...input, question: 'something else entirely', conceptsAnswer: 'x' });
    expect(a.system).toEqual([{ text: EXTRACTION_PROMPT, cacheBoundary: true }]);
    expect(JSON.stringify(a.system)).toBe(JSON.stringify(b.system));
  });

  it('keeps the prompt free of anything interpolated', () => {
    expect(EXTRACTION_PROMPT).not.toMatch(/\$\{|\d{4}-\d{2}-\d{2}|[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it('runs at temperature 0 on the model it is given', () => {
    const request = buildExtractionRequest(input);
    expect(request.temperature).toBe(0);
    expect(request.model).toBe('gemini-3.7-flash');
  });

  it('lists the library in path order whatever order it arrives in', () => {
    const forward = buildExtractionRequest(input);
    const backward = buildExtractionRequest({ ...input, library: [...library].reverse() });
    expect(forward.messages).toEqual(backward.messages);
    const text = forward.messages[0]?.content as string;
    expect(text.indexOf('/concepts/closures.md')).toBeLessThan(text.indexOf('/concepts/row-level-security.md'));
  });

  it('delimits learner text as data and truncates an oversized answer', () => {
    const request = buildExtractionRequest({ ...input, conceptsAnswer: 'x'.repeat(50_000) });
    const text = request.messages[0]?.content as string;
    expect(text).toContain('<question>');
    expect(text).toContain('<answer>');
    expect(text.length).toBeLessThan(EXTRACTION_LIMITS.answerChars + EXTRACTION_LIMITS.questionChars + 1_000);
  });
});

describe('the extraction schema', () => {
  it('fills missing arrays with empty ones', () => {
    expect(Extraction.parse({})).toEqual({ concepts: [], insights: [], mistakes: [] });
  });

  it('rejects output of the wrong shape', () => {
    expect(Extraction.safeParse({ concepts: 'closures' }).success).toBe(false);
    expect(Extraction.safeParse({ concepts: [{ okfPath: null }] }).success).toBe(false);
  });
});

describe('normaliseExtraction', () => {
  it('caps the number of concepts, insights and mistakes', () => {
    const raw = Extraction.parse({
      concepts: Array.from({ length: 12 }, (_, i) => ({ label: `concept ${i}` })),
      insights: Array.from({ length: 9 }, (_, i) => ({ text: `insight ${i}` })),
      mistakes: Array.from({ length: 9 }, (_, i) => ({ text: `mistake ${i}` })),
    });
    const out = normaliseExtraction(raw);
    expect(out.concepts).toHaveLength(EXTRACTION_LIMITS.concepts);
    expect(out.insights).toHaveLength(EXTRACTION_LIMITS.insights);
    expect(out.mistakes).toHaveLength(EXTRACTION_LIMITS.mistakes);
  });

  it('collapses concepts that canonicalise to the same key, keeping the first label', () => {
    const out = normaliseExtraction(
      Extraction.parse({ concepts: [{ label: 'Closures' }, { label: 'closures' }, { label: ' CLOSURES ' }] }),
    );
    expect(out.concepts).toEqual([{ label: 'Closures', okfPath: null }]);
  });

  it('drops blanks and clips long text', () => {
    const out = normaliseExtraction(
      Extraction.parse({
        concepts: [{ label: '   ' }, { label: '!!!' }, { label: 'Event loop', okfPath: '  ' }],
        insights: [{ text: '' }, { text: 'y'.repeat(1000) }],
      }),
    );
    expect(out.concepts).toEqual([{ label: 'Event loop', okfPath: null }]);
    expect(out.insights).toHaveLength(1);
    expect(out.insights[0]?.text.length).toBe(EXTRACTION_LIMITS.insightChars);
  });

  it('is idempotent', () => {
    const once = normaliseExtraction(
      Extraction.parse({
        concepts: [{ label: 'Closures', okfPath: '/concepts/closures.md' }],
        insights: [{ text: 'A closure keeps its scope.', concepts: ['Closures'] }],
        mistakes: [{ text: 'Thinks closures copy values', concept: 'Closures' }],
      }),
    );
    expect(normaliseExtraction(once)).toEqual(once);
  });
});
