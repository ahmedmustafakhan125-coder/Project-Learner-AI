/**
 * Tech cards and the doc-source registry, loaded through the knowledge path
 * (docs/project-learner.md §12). Runs against the committed files: a card or
 * a registry entry that does not load is a research pass that silently has
 * less to stand on.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { PROFILES, isFreshCard } from '@ai-edu/core';
import { describe, expect, it } from 'vitest';

import { KNOWLEDGE_ROOT, loadDocSources, loadKnowledgeBundle, loadTechCards } from '../src/knowledge.js';

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'okf-tech-'));
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, 'utf-8');
  }
  return root;
}

const CARD = [
  '---',
  'type: TechCard',
  'id: tauri',
  'title: Tauri 2',
  'description: Desktop apps with a webview UI.',
  'pin: "2"',
  'pinnedOn: 2026-10-23',
  'docs: https://v2.tauri.app/start/',
  '---',
  'Body.',
].join('\n');

describe('loadTechCards', () => {
  it('reads cards from tech/, with the body', () => {
    const root = fixture({ 'tech/tauri.md': CARD, 'concepts/x.md': '---\ntype: Concept\n---\nX' });
    const cards = loadTechCards(root);
    expect(cards.map((c) => c.id)).toEqual(['tauri']);
    expect(cards[0]).toMatchObject({ pin: '2', pinnedOn: '2026-10-23', body: 'Body.' });
  });

  it('keeps cards out of the concept bundle the fan-out reads', () => {
    const root = fixture({ 'tech/tauri.md': CARD, 'concepts/x.md': '---\ntype: Concept\ntags: [x]\n---\nX' });
    expect(loadKnowledgeBundle(root).concepts.map((c) => c.path)).toEqual(['/concepts/x.md']);
  });

  it('refuses a malformed card rather than loading half of it', () => {
    const root = fixture({ 'tech/bad.md': '---\ntype: TechCard\nid: Bad Id\n---\n' });
    expect(() => loadTechCards(root)).toThrow(/bad\.md/);
  });

  it('returns no cards when there is no tech directory', () => {
    expect(loadTechCards(fixture({}))).toEqual([]);
  });
});

describe('the committed cards and registry', () => {
  const cards = loadTechCards(KNOWLEDGE_ROOT);
  const registry = loadDocSources(KNOWLEDGE_ROOT);

  it('loads the phase 2 cards, each fresh today and with a registry entry', () => {
    expect(cards.map((c) => c.id).sort()).toEqual(
      ['limine', 'lox', 'python', 'qemu', 'rust', 'sqlite', 'tauri', 'x86-64-cross'].sort(),
    );
    for (const card of cards) {
      expect(isFreshCard(card, new Date('2026-10-24T00:00:00Z')), card.id).toBe(true);
      expect(registry, card.id).toHaveProperty([`tech:${card.id}`]);
    }
  });

  it('has every key the profiles name and a domain list for each deep profile', () => {
    for (const profile of Object.values(PROFILES)) {
      for (const ref of profile.docSources) expect(registry, `${profile.id}: ${ref.key}`).toHaveProperty([ref.key]);
    }
    for (const id of ['systems-os', 'desktop-app', 'language-tooling']) {
      expect(registry[`profile:${id}`]!.domains.length, id).toBeGreaterThan(0);
    }
    expect(registry['profile:general']!.blocked.length).toBeGreaterThan(0);
  });

  it('has a registry entry for every research key a deep profile names', () => {
    for (const id of ['systems-os', 'desktop-app', 'language-tooling'] as const) {
      for (const layer of PROFILES[id].layers) expect(registry, `${id}.${layer.id}`).toHaveProperty([`tech:${layer.research}`]);
    }
  });

  it('puts every card docs URL on its own allowlist', () => {
    for (const card of cards) {
      const host = new URL(card.docs).host;
      expect(registry[`tech:${card.id}`]!.domains.some((d) => d === host || d.startsWith(`${host}/`)), card.id).toBe(true);
    }
  });
});
