import { describe, expect, it } from 'vitest';

import sources from '../../../knowledge/docs/sources.json';
import { PROFILES } from '../src/profiles/index.js';
import { parseDossier } from '../src/research/dossier.js';
import { DocSourceRegistry, isAllowedUrl, researchScope } from '../src/research/sources.js';
import { verifyDossier } from '../src/research/verify.js';
import recorded from './fixtures/research-live.response.json';

/**
 * `research.parseDossier` on a recorded live response (§14): one real
 * systems-os research call, saved by `npm run test:research` with
 * RECORD_FIXTURES=1, with page text and encrypted content removed.
 *
 * The 20260318 tools read pages through code execution, and the model then
 * cites by writing each page's URL rather than through citation blocks. Only
 * URLs the tools returned become references.
 */

const registry = DocSourceRegistry.parse(sources);
const profile = PROFILES['systems-os'];

describe('the recorded systems-os research', () => {
  const parsed = parseDossier(recorded as never, { vetted: true, retrievedAt: recorded.recordedAt });
  const scope = researchScope(registry, profile, recorded.keys);
  const read = new Set(recorded.sources.map((s: { url: string }) => s.url));

  it('becomes references only to pages a server tool returned', () => {
    expect(parsed.dossier.docRefs.length).toBeGreaterThan(0);
    for (const ref of parsed.dossier.docRefs) expect(read.has(ref.url), ref.url).toBe(true);
  });

  it('stays on the allowlist built from sources.json', () => {
    for (const ref of parsed.dossier.docRefs) expect(isAllowedUrl(ref.url, scope.allowedDomains!), ref.url).toBe(true);
  });

  it('leaves no raw URL and no untagged line in the notes', () => {
    expect(parsed.dossier.notes).not.toMatch(/https?:\/\//);
    expect(verifyDossier(parsed.dossier, { allowedDomains: scope.allowedDomains, candidates: [] })).toEqual([]);
  });

  it('gives each researched key its own slice that passes verifyDossier', () => {
    for (const slice of parsed.slices) {
      expect(recorded.keys).toContain(slice.key);
      expect(verifyDossier(slice.dossier, { allowedDomains: scope.allowedDomains, candidates: [slice.key] })).toEqual([]);
    }
  });

  it('fills the structured APIs from the "symbol | signature" bullets', () => {
    expect(parsed.dossier.apis.length).toBeGreaterThan(0);
    for (const api of parsed.dossier.apis) expect(parsed.dossier.docRefs.map((r) => r.id)).toContain(api.ref);
  });

  it('records usage with fetches counted', () => {
    expect(recorded.usage.webFetchRequests ?? 0).toBeGreaterThan(0);
  });
});
