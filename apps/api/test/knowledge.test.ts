/**
 * OKF bundle loader.
 *
 * Runs against the real `knowledge/` directory in the repository as well as
 * synthetic fixtures — the committed bundle being loadable is the thing that
 * actually matters, and a fixture-only test would not notice it breaking.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadKnowledgeBundle, parseFrontmatter } from '../src/knowledge.js';

const NL = String.fromCharCode(10);

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'okf-'));
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, 'utf-8');
  }
  return root;
}

function doc(frontmatter: string, body: string): string {
  return '---' + NL + frontmatter + NL + '---' + NL + body;
}

describe('parseFrontmatter', () => {
  it('splits YAML frontmatter from the body', () => {
    const { frontmatter, body } = parseFrontmatter(doc('type: Concept' + NL + 'title: X', 'Body.'));
    expect(frontmatter.type).toBe('Concept');
    expect(frontmatter.title).toBe('X');
    expect(body.trim()).toBe('Body.');
  });

  it('treats a file with no frontmatter as having none, rather than throwing', () => {
    const { frontmatter, body } = parseFrontmatter('# Just markdown');
    expect(frontmatter).toEqual({});
    expect(body).toBe('# Just markdown');
  });
});

describe('loadKnowledgeBundle', () => {
  it('returns an empty bundle when the directory does not exist', () => {
    const bundle = loadKnowledgeBundle(join(tmpdir(), 'definitely-not-a-bundle-' + Date.now()));
    expect(bundle.concepts).toEqual([]);
    expect(bundle.index).toBeNull();
  });

  it('loads concepts and treats index.md as the listing, not a concept', () => {
    const root = fixture({
      'index.md': '# Listing' + NL + '- [A](/a.md)',
      'a.md': doc('type: Concept' + NL + 'title: A' + NL + 'tags: [x, y]', 'Body A'),
    });
    try {
      const bundle = loadKnowledgeBundle(root);
      expect(bundle.index).toContain('# Listing');
      expect(bundle.concepts).toHaveLength(1);
      expect(bundle.concepts[0]!.path).toBe('/a.md');
      expect(bundle.concepts[0]!.tags).toEqual(['x', 'y']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips reserved filenames and files with no type', () => {
    const root = fixture({
      'index.md': 'listing',
      'log.md': doc('type: Log', 'history'),
      'README.md': '# Not a concept, no frontmatter',
      'real.md': doc('type: Concept', 'body'),
    });
    try {
      const paths = loadKnowledgeBundle(root).concepts.map((c) => c.path);
      expect(paths).toEqual(['/real.md']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses slash-separated bundle-relative paths in nested directories', () => {
    const root = fixture({
      'index.md': 'listing',
      [join('concepts', 'nested.md')]: doc('type: Concept', 'body'),
    });
    try {
      // Concepts link to each other with these paths, so they must be POSIX-style
      // even when the bundle was read on Windows.
      expect(loadKnowledgeBundle(root).concepts[0]!.path).toBe('/concepts/nested.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaults an unknown status to stable rather than dropping the concept', () => {
    const root = fixture({ 'a.md': doc('type: Concept' + NL + 'status: bogus', 'body') });
    try {
      expect(loadKnowledgeBundle(root).concepts[0]!.status).toBe('stable');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('orders concepts deterministically regardless of directory enumeration', () => {
    const root = fixture({
      'index.md': 'listing',
      'z.md': doc('type: Concept', 'z'),
      'a.md': doc('type: Concept', 'a'),
      'm.md': doc('type: Concept', 'm'),
    });
    try {
      expect(loadKnowledgeBundle(root).concepts.map((c) => c.path)).toEqual([
        '/a.md',
        '/m.md',
        '/z.md',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the committed bundle', () => {
  const root = resolve(__dirname, '..', '..', '..', 'knowledge');

  it('loads, and every concept carries the one required OKF field', () => {
    const bundle = loadKnowledgeBundle(root);
    expect(bundle.concepts.length).toBeGreaterThan(0);
    for (const concept of bundle.concepts) {
      expect(concept.type, concept.path).toBeTruthy();
      expect(concept.body.trim(), concept.path).not.toBe('');
    }
  });

  it('has an index listing, which is what progressive disclosure relies on', () => {
    expect(loadKnowledgeBundle(root).index).toBeTruthy();
  });

  it('gives every concept tags, or selection can never surface it', () => {
    for (const concept of loadKnowledgeBundle(root).concepts) {
      expect(concept.tags.length, `${concept.path} has no tags`).toBeGreaterThan(0);
    }
  });
});
