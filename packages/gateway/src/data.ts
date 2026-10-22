/**
 * The labelled datasets in `data/`, carried over from the Python gateway:
 * `train_injection.csv` trains the semantic detector, and `final_eval.csv` is
 * the 164-prompt evaluation set its reported figures come from.
 */

import { readFileSync } from 'node:fs';

import type { TrainingRow } from './semantic.js';

const DATA_DIR = new URL('../data/', import.meta.url);

/** RFC 4180: quoted fields may hold commas, newlines and doubled quotes. */
export function parseCsv(source: string): Record<string, string>[] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (source[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field || record.length > 0) records.push([...record, field]);

  const [header, ...rows] = records.filter((r) => r.some(Boolean));
  if (!header) return [];
  return rows.map((row) => Object.fromEntries(header.map((name, i) => [name, row[i] ?? ''])));
}

function readDataset(name: string): Record<string, string>[] {
  return parseCsv(readFileSync(new URL(name, DATA_DIR), 'utf8'));
}

export function trainingRows(): TrainingRow[] {
  return readDataset('train_injection.csv').map((row) => {
    const label = Number(row.label);
    if (label !== 0 && label !== 1) throw new Error(`train_injection.csv: label must be 0 or 1, got "${row.label}"`);
    return { text: row.text ?? '', label };
  });
}

export interface EvaluationRow {
  id: string;
  prompt: string;
  language: string;
  attackType: string;
  expectedPolicy: string;
  expectedEntities: string[];
}

export function evaluationRows(): EvaluationRow[] {
  return readDataset('final_eval.csv').map((row) => ({
    id: row.id ?? '',
    prompt: row.prompt ?? '',
    language: row.language ?? '',
    attackType: row.attack_type ?? '',
    expectedPolicy: row.expected_policy ?? '',
    expectedEntities: (row.expected_entities ?? '').split('|').filter(Boolean),
  }));
}
