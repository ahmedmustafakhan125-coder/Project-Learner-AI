/**
 * The evaluation: every prompt in data/final_eval.csv, run rule-only and then
 * hybrid (rule + semantic), scored as the Python gateway's run_evaluation.py
 * scored them, so the figures compare directly with its metrics_summary.json.
 *
 *   npm run eval --workspace=@ai-edu/gateway
 */

import { evaluationRows } from './data.js';
import { analyze, prepare } from './index.js';

export interface ModeMetrics {
  mode: 'rule_only' | 'hybrid';
  total: number;
  correct: number;
  accuracy: number;
  /** BLOCK as the positive class, the one that matters most. */
  blockClass: { tp: number; fp: number; fn: number; tn: number; precision: number; recall: number; f1: number };
  /** Recall on the rows that should be blocked, per language. */
  perLanguage: Record<string, { totalAttacks: number; blocked: number; recall: number }>;
  latencyMs: { mean: number; median: number; p95: number };
}

export interface EvaluatedRow {
  id: string;
  prompt: string;
  expected: string;
  got: string;
}

const round = (value: number, places: number) => Number(value.toFixed(places));

export function evaluate(useSemantic: boolean): { metrics: ModeMetrics; rows: EvaluatedRow[] } {
  const rows: EvaluatedRow[] = [];
  const latencies: number[] = [];
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const perLanguage: ModeMetrics['perLanguage'] = {};

  for (const row of evaluationRows()) {
    const expected = row.expectedPolicy === 'FLAG' ? 'ALLOW' : row.expectedPolicy;
    const result = analyze(row.prompt, { inputId: row.id, useSemantic });
    latencies.push(result.latencyMs);
    rows.push({ id: row.id, prompt: row.prompt, expected, got: result.decision });

    const shouldBlock = expected === 'BLOCK';
    const blocked = result.decision === 'BLOCK';
    if (shouldBlock && blocked) tp++;
    else if (!shouldBlock && blocked) fp++;
    else if (shouldBlock) fn++;
    else tn++;

    if (shouldBlock) {
      const lang = (perLanguage[row.language] ??= { totalAttacks: 0, blocked: 0, recall: 0 });
      lang.totalAttacks++;
      if (blocked) lang.blocked++;
    }
  }

  for (const lang of Object.values(perLanguage)) lang.recall = round(lang.blocked / lang.totalAttacks, 3);

  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const correct = rows.filter((row) => row.got === row.expected).length;

  const sorted = [...latencies].sort((a, b) => a - b);
  const n = sorted.length;
  const median = n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;

  return {
    rows,
    metrics: {
      mode: useSemantic ? 'hybrid' : 'rule_only',
      total: rows.length,
      correct,
      accuracy: round(correct / rows.length, 3),
      blockClass: { tp, fp, fn, tn, precision: round(precision, 3), recall: round(recall, 3), f1: round(f1, 3) },
      perLanguage,
      latencyMs: {
        mean: round(latencies.reduce((sum, ms) => sum + ms, 0) / n, 2),
        median: round(median, 2),
        p95: round(sorted[Math.max(0, Math.floor(0.95 * n) - 1)]!, 2),
      },
    },
  };
}

function main(): void {
  prepare();
  for (const useSemantic of [false, true]) {
    const { metrics: m, rows } = evaluate(useSemantic);
    const b = m.blockClass;
    console.log(
      `${m.mode.padEnd(10)} | acc=${m.accuracy.toFixed(3)}  P=${b.precision.toFixed(3)}  R=${b.recall.toFixed(3)}  ` +
        `F1=${b.f1.toFixed(3)}  mean_ms=${m.latencyMs.mean}`,
    );
    for (const [lang, v] of Object.entries(m.perLanguage)) {
      console.log(`  ${lang}: ${v.blocked}/${v.totalAttacks} = ${v.recall.toFixed(3)}`);
    }
    for (const row of rows.filter((r) => r.got !== r.expected)) {
      console.log(`    ${row.id}  expected ${row.expected}, got ${row.got}: ${row.prompt}`);
    }
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!)) {
  main();
}
