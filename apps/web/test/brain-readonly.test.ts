import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Invariant 10: the browser can read the brain and write none of it.
 *
 * The database enforces this — 0011_brain.sql grants the browser roles SELECT
 * only and revokes everything else. This is the other half: no client code
 * names a brain table or the projection RPC at all, so a future change cannot
 * start writing the projection from the browser and discover the database
 * refusing it only in production. Everything the UI knows about the brain
 * arrives through the API.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');

const CLIENT_ROOTS = ['apps/web/app', 'apps/web/components', 'apps/web/lib', 'packages/api-client/src'];

const FORBIDDEN =
  /\b(brain_events|brain_nodes|brain_edges|brain_query_fingerprints|brain_projection_state|brain_replace_projection)\b/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry)) out.push(path);
  }
  return out;
}

describe('the brain projection is read-only from the client', () => {
  const files = CLIENT_ROOTS.flatMap((root) => sourceFiles(join(repo, root)));

  it('scans the client code, or this test is watching nothing', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith(join('components', 'brain', 'BrainView.tsx')))).toBe(true);
  });

  it('no client source names a brain table or the projection RPC', () => {
    const offenders = files
      .filter((file) => FORBIDDEN.test(readFileSync(file, 'utf-8')))
      .map((file) => relative(repo, file));
    expect(offenders).toEqual([]);
  });
});
