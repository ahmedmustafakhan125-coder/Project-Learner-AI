import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { DocSourceRegistry, KnowledgeBundle, TechCard, type KnowledgeConcept } from '@ai-edu/core';
import { parse as parseYaml } from 'yaml';

/**
 * Load the OKF knowledge bundle off disk.
 *
 * This lives in `apps/api` rather than `packages/core` because core has to run
 * unchanged under React Native, where `node:fs` does not exist — the ESLint
 * portability guard bans the import outright. Core gets the parsed bundle as
 * plain data and does the selecting and rendering, which keeps the interesting
 * logic portable and testable without a filesystem.
 *
 * The bundle is read once at startup and cached. It is committed to the repo and
 * changes only with a deploy, so re-reading it per request would buy nothing and
 * put file I/O on the hot path in front of the fan-out.
 */

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Reserved by the spec: directory listing and update history, not concepts. */
const RESERVED = new Set(['index.md', 'log.md']);

interface ParsedDocument {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Split YAML frontmatter from the Markdown body.
 *
 * A file with no frontmatter is not an OKF concept. It is returned with an empty
 * frontmatter object so the caller can skip it by the missing `type` rather than
 * needing a second code path.
 */
export function parseFrontmatter(source: string): ParsedDocument {
  const match = FRONTMATTER.exec(source);
  if (!match) return { frontmatter: {}, body: source };

  const parsed = parseYaml(match[1] ?? '') as unknown;
  const frontmatter =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};

  return { frontmatter, body: source.slice(match[0].length) };
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return [value];
  return [];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/**
 * Read a bundle from `root`.
 *
 * Files without a `type` are skipped rather than rejected: OKF explicitly allows
 * a bundle to sit inside a larger repository, so a stray README is expected and
 * is not a configuration error.
 */
export function loadKnowledgeBundle(root: string): KnowledgeBundle {
  if (!existsSync(root)) {
    return KnowledgeBundle.parse({ index: null, concepts: [] });
  }

  const indexPath = join(root, 'index.md');
  const index = existsSync(indexPath)
    ? parseFrontmatter(readFileSync(indexPath, 'utf-8')).body.trim()
    : null;

  const concepts: KnowledgeConcept[] = [];

  for (const file of walk(root)) {
    const name = file.slice(file.lastIndexOf(sep) + 1);
    if (RESERVED.has(name)) continue;

    const { frontmatter, body } = parseFrontmatter(readFileSync(file, 'utf-8'));
    if (typeof frontmatter.type !== 'string') continue;
    // Tech cards feed the research pass and the Stack Brief, not the fan-out.
    if (frontmatter.type === TECH_CARD_TYPE) continue;

    // Bundle-relative and slash-separated, because that is the form concepts use
    // to link to each other — and the form has to match on Windows too.
    const path = '/' + relative(root, file).split(sep).join('/');

    const status = frontmatter.status;
    concepts.push({
      path,
      type: frontmatter.type,
      ...(typeof frontmatter.title === 'string' ? { title: frontmatter.title } : {}),
      ...(typeof frontmatter.description === 'string'
        ? { description: frontmatter.description }
        : {}),
      tags: asStringArray(frontmatter.tags),
      status:
        status === 'draft' || status === 'deprecated' || status === 'stable' ? status : 'stable',
      body,
    });
  }

  // Sorted so the bundle's own order never depends on how the filesystem
  // happened to enumerate it — selection is deterministic, and this is where
  // that starts.
  concepts.sort((a, b) => a.path.localeCompare(b.path));

  return KnowledgeBundle.parse({ index, concepts });
}

/* ------------------------------------------------------------------ *
 * Tech cards and the doc-source registry (docs/project-learner.md §7)
 * ------------------------------------------------------------------ */

const TECH_CARD_TYPE = 'TechCard';

/** YAML may read `2026-10-23` as a date; a card stores the ISO day. */
function isoDay(value: unknown): unknown {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

/**
 * Read `tech/*.md`. A card that does not parse fails loudly, naming the file:
 * a half-read card would ground a brief in facts nobody reviewed.
 */
export function loadTechCards(root: string): TechCard[] {
  const dir = join(root, 'tech');
  if (!existsSync(dir)) return [];

  const cards: TechCard[] = [];
  for (const file of walk(dir)) {
    const { frontmatter, body } = parseFrontmatter(readFileSync(file, 'utf-8'));
    if (frontmatter.type !== TECH_CARD_TYPE) continue;
    const { type: _type, ...fields } = frontmatter;
    const parsed = TechCard.safeParse({ ...fields, pinnedOn: isoDay(fields.pinnedOn), body: body.trim() });
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`Tech card ${relative(root, file)} is invalid: ${issues}`);
    }
    cards.push(parsed.data);
  }
  return cards.sort((a, b) => a.id.localeCompare(b.id));
}

/** Read `docs/sources.json`. Missing means no allowlist at all, so research cannot run. */
export function loadDocSources(root: string): DocSourceRegistry {
  const path = join(root, 'docs', 'sources.json');
  if (!existsSync(path)) return {};
  return DocSourceRegistry.parse(JSON.parse(readFileSync(path, 'utf-8')));
}

/* ------------------------------------------------------------------ *
 * Process-wide cache
 * ------------------------------------------------------------------ */

let cached: KnowledgeBundle | null = null;
let cachedCards: TechCard[] | null = null;
let cachedSources: DocSourceRegistry | null = null;

/** Where the bundle lives, relative to the repository root. */
export const KNOWLEDGE_ROOT = existsSync(resolve(process.cwd(), 'knowledge'))
  ? resolve(process.cwd(), 'knowledge')
  : resolve(process.cwd(), '..', '..', 'knowledge');

export function knowledgeBundle(): KnowledgeBundle {
  cached ??= loadKnowledgeBundle(KNOWLEDGE_ROOT);
  return cached;
}

export function techCards(): TechCard[] {
  cachedCards ??= loadTechCards(KNOWLEDGE_ROOT);
  return cachedCards;
}

export function docSources(): DocSourceRegistry {
  cachedSources ??= loadDocSources(KNOWLEDGE_ROOT);
  return cachedSources;
}

/** Test-only: drop the cache so a different bundle can be loaded. */
export function resetKnowledgeCache(): void {
  cached = null;
  cachedCards = null;
  cachedSources = null;
}
