import type { LLMResponse } from '@ai-edu/llm';

import { MAX_CITED_CHARS, ResearchDossier } from '../schemas/research.js';
import type { DocRef, DossierScope } from '../schemas/research.js';
import type { TechCard } from './sources.js';

/**
 * Building, splitting and merging Research Dossiers, deterministically
 * (docs/project-learner.md §7).
 *
 * The research call answers in Markdown under fixed headings, one `# key`
 * section per research key. Citations arrive as structured blocks beside the
 * text, never as text the model typed, so a reference tag here always points
 * at a page a server tool actually read.
 */

/** `[d3]` in the notes. */
export const REF_TAG = /\[(d\d+)\]/g;

const SECTION = /^#\s+(.+?)\s*$/;
const HEADING = /^##\s+(.+?)\s*$/;
const BULLET = /^\s*[-*]\s+(.*)$/;

export interface DossierSlice {
  /** The research key this part of the dossier grounds. */
  key: string;
  dossier: ResearchDossier;
}

export interface ParsedResearch {
  /** Everything cited, every key together. */
  dossier: ResearchDossier;
  /** One dossier per `# key` section: what the technology cache stores. */
  slices: DossierSlice[];
  /** Lines with no citation, left out. A fact nobody can check is not kept. */
  droppedLines: number;
}

export interface ParseOptions {
  scope?: DossierScope;
  /** False under `general`. */
  vetted: boolean;
  /** Stamped on references whose page reported no retrieval time. */
  retrievedAt: string;
}

/** A quote cut to the stored limit at a word boundary. Steps paraphrase and link. */
export function clipCitedText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= MAX_CITED_CHARS) return flat;
  const cut = flat.slice(0, MAX_CITED_CHARS);
  const space = cut.lastIndexOf(' ');
  return (space > MAX_CITED_CHARS / 2 ? cut.slice(0, space) : cut).trim();
}

/** A page title from its URL, for a page whose tool result carried none. */
function titleFromUrl(url: string): string {
  const match = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(url);
  if (!match) return url;
  const last = match[2]!.split('/').filter(Boolean).pop();
  const name = last ? decodeURIComponent(last).replace(/\.[a-z]+$/i, '').replace(/[_-]+/g, ' ').trim() : '';
  return name ? `${name} (${match[1]})` : match[1]!;
}

/** The same page whatever trailing slash, fragment or punctuation it was written with. */
function pageKey(url: string): string {
  return url.replace(/[).,;:]+$/, '').replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
}

/** `[title](url)`, `(url)` or a bare URL, in that order of precedence. */
const MD_LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
const PAREN_URL = /\s*\((https?:\/\/[^)\s]+)\)/g;
const BARE_URL = /\s*(https?:\/\/[^\s)\]]+)/g;

/**
 * Turn a research response into a dossier.
 *
 * Each cited span gets the tags of the pages it cites, appended where the span
 * ends. With the 20260318 tools the model often reads pages through code
 * execution and writes the page's URL at the end of a bullet instead of
 * returning a citation block; such a URL becomes a tag only when it is a page
 * a server tool actually returned (`sources`), and is removed otherwise. Lines
 * are then kept only under a heading and only with a tag; the `Versions`,
 * `Setup` and `APIs` bullets (`- name | value`) also fill the structured
 * lists, each pointing at the first page its line cites.
 */
export function parseDossier(response: Pick<LLMResponse, 'text' | 'segments' | 'sources'>, options: ParseOptions): ParsedResearch {
  const { scope = 'project', vetted, retrievedAt } = options;
  const refs: DocRef[] = [];
  const idForUrl = new Map<string, string>();

  const retrievedFor = (url: string) =>
    response.sources?.find((s) => s.url === url && s.retrievedAt)?.retrievedAt ?? retrievedAt;
  const titleFor = (url: string, title: string | null) =>
    title?.trim() || response.sources?.find((s) => s.url === url && s.title)?.title?.trim() || titleFromUrl(url);

  const refId = (url: string, title: string | null, citedText: string): string => {
    const existing = idForUrl.get(url);
    if (existing) return existing;
    const id = `d${refs.length + 1}`;
    idForUrl.set(url, id);
    refs.push({ id, url, title: titleFor(url, title), citedText: clipCitedText(citedText), retrievedAt: retrievedFor(url), vetted });
    return id;
  };

  // Tags go at the end of the span, before any line break it ends with, so
  // they land on the line the claim is on.
  const segments = response.segments ?? [{ text: response.text, citations: [] }];
  let text = '';
  for (const segment of segments) {
    // Text blocks join with nothing between them, so a heading that opens a
    // block after a sentence would otherwise share its line and be lost.
    if (/^#/.test(segment.text) && text !== '' && !text.endsWith('\n')) text += '\n';
    const ids = [...new Set(segment.citations.map((c) => refId(c.url, c.title, c.citedText)))];
    if (ids.length === 0) {
      text += segment.text;
      continue;
    }
    const trailing = /\s*$/.exec(segment.text)?.[0] ?? '';
    text += `${segment.text.slice(0, segment.text.length - trailing.length)} ${ids.map((id) => `[${id}]`).join('')}${trailing}`;
  }

  // Inline URLs, resolved against what the tools returned and nothing else.
  const read = new Map<string, string>();
  for (const source of response.sources ?? []) {
    if (!read.has(pageKey(source.url))) read.set(pageKey(source.url), source.url);
  }
  const tagFor = (url: string): string | null => {
    const page = read.get(pageKey(url));
    return page ? `[${refId(page, null, '')}]` : null;
  };
  text = text
    .replace(MD_LINK, (_whole, label: string, url: string) => {
      const tag = tagFor(url);
      return tag ? `${label} ${tag}` : label;
    })
    .replace(PAREN_URL, (_whole, url: string) => {
      const tag = tagFor(url);
      return tag ? ` ${tag}` : '';
    })
    .replace(BARE_URL, (whole, url: string) => {
      const tag = tagFor(url);
      return tag ? ` ${tag}` : whole.startsWith(' ') ? ' ' : '';
    });

  return buildDossier(text, refs, scope);
}

interface Section {
  key: string;
  headings: { heading: string; lines: string[] }[];
}

function buildDossier(text: string, refs: DocRef[], scope: DossierScope): ParsedResearch {
  const sections: Section[] = [];
  let section: Section | null = null;
  let heading: Section['headings'][number] | null = null;
  let droppedLines = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const s = SECTION.exec(line);
    if (s && !line.startsWith('##')) {
      section = { key: s[1]!.replace(REF_TAG, '').trim().toLowerCase(), headings: [] };
      sections.push(section);
      heading = null;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      if (!section) {
        section = { key: '', headings: [] };
        sections.push(section);
      }
      heading = { heading: h[1]!.replace(REF_TAG, '').trim(), lines: [] };
      section.headings.push(heading);
      continue;
    }
    const tagged = line.match(REF_TAG) !== null;
    if (!tagged || !section || !heading) {
      droppedLines += 1;
      continue;
    }
    const bullet = BULLET.exec(line)?.[1] ?? line.trim();
    heading.lines.push(bullet);
  }

  const known = new Set(refs.map((r) => r.id));
  const slices: DossierSlice[] = [];
  const all = emptyDossier(scope);
  const usedIds = new Set<string>();

  for (const sec of sections) {
    const slice = emptyDossier(scope);
    const notes: string[] = [];
    for (const { heading: name, lines } of sec.headings) {
      const kept = lines.filter((l) => [...l.matchAll(REF_TAG)].every((m) => known.has(m[1]!)));
      if (kept.length === 0) continue;
      notes.push(`## ${name}`, ...kept.map((l) => `- ${l}`));
      for (const line of kept) {
        const ids = [...line.matchAll(REF_TAG)].map((m) => m[1]!);
        ids.forEach((id) => usedIds.add(id));
        collectStructured(slice, name, line, ids[0]!);
      }
    }
    if (notes.length === 0) continue;
    const sliceNotes = sec.key ? [`# ${sec.key}`, ...notes].join('\n') : notes.join('\n');
    const ids = new Set([...sliceNotes.matchAll(REF_TAG)].map((m) => m[1]!));
    slice.notes = sliceNotes;
    slice.docRefs = refs.filter((r) => ids.has(r.id));
    all.notes = all.notes ? `${all.notes}\n\n${sliceNotes}` : sliceNotes;
    all.versions.push(...slice.versions);
    all.apis.push(...slice.apis);
    all.toolchain.push(...slice.toolchain);
    if (sec.key) slices.push({ key: sec.key, dossier: ResearchDossier.parse(slice) });
  }

  all.docRefs = refs.filter((r) => usedIds.has(r.id));
  return { dossier: ResearchDossier.parse(all), slices, droppedLines };
}

function emptyDossier(scope: DossierScope): ResearchDossier {
  return { scope, notes: '', docRefs: [], versions: [], apis: [], toolchain: [] };
}

/** `name | value [d1]` under Versions, Setup and APIs fills the lists the brief checks. */
function collectStructured(into: ResearchDossier, heading: string, line: string, ref: string): void {
  const plain = line.replace(REF_TAG, '').trim();
  const bar = plain.indexOf('|');
  if (bar === -1) return;
  const left = plain.slice(0, bar).replace(/`/g, '').trim();
  const right = plain.slice(bar + 1).replace(/`/g, '').trim();
  if (!left || !right) return;
  const h = heading.toLowerCase();
  if (h.startsWith('version')) into.versions.push({ tech: left, versionSeen: right, ref });
  else if (h.startsWith('setup') || h.startsWith('toolchain') || h.startsWith('install')) into.toolchain.push({ tool: left, install: right, ref });
  else if (h.startsWith('api')) into.apis.push({ symbol: left, signature: right, ref });
}

/* ------------------------------------------------------------------ *
 * Tech cards and merging
 * ------------------------------------------------------------------ */

/**
 * A dossier from tech cards alone: one reference per card, at its docs entry
 * URL, so every layer a card fills can cite something. The notes carry only
 * what the card states.
 */
export function dossierFromCards(cards: TechCard[]): ResearchDossier {
  const dossier = emptyDossier('project');
  const notes: string[] = [];
  cards.forEach((card, i) => {
    const id = `d${i + 1}`;
    dossier.docRefs.push({
      id,
      url: card.docs,
      title: card.title,
      citedText: clipCitedText(card.description),
      retrievedAt: card.pinnedOn,
      vetted: true,
    });
    notes.push(`# ${card.id}`, '## Notes', `- ${card.description} [${id}]`);
    if (card.pin) {
      notes.push('## Versions', `- ${card.title} | ${card.pin} [${id}]`);
      dossier.versions.push({ tech: card.id, versionSeen: card.pin, ref: id });
    }
    const installs = Object.entries(card.install).filter(([, cmd]) => cmd);
    if (installs.length) {
      notes.push('## Setup', ...installs.map(([os, cmd]) => `- ${card.title} on ${os} | ${cmd} [${id}]`));
      for (const [os, cmd] of installs) dossier.toolchain.push({ tool: `${card.title} (${os})`, install: cmd!, ref: id });
    }
    notes.push('');
  });
  dossier.notes = notes.join('\n').trim();
  return ResearchDossier.parse(dossier);
}

/**
 * One dossier from several, references renumbered once per URL and every tag
 * rewritten to match. Order is kept, so the same inputs always merge to the
 * same bytes — the dossier sits inside cached prompt prefixes.
 */
export function mergeDossiers(dossiers: ResearchDossier[], scope: DossierScope = 'project'): ResearchDossier {
  const merged = emptyDossier(scope);
  const idForUrl = new Map<string, string>();
  const notes: string[] = [];
  const seen = { versions: new Set<string>(), apis: new Set<string>(), toolchain: new Set<string>() };

  for (const dossier of dossiers) {
    const rename = new Map<string, string>();
    for (const ref of dossier.docRefs) {
      let id = idForUrl.get(ref.url);
      if (!id) {
        id = `d${merged.docRefs.length + 1}`;
        idForUrl.set(ref.url, id);
        merged.docRefs.push({ ...ref, id });
      }
      rename.set(ref.id, id);
    }
    const retag = (s: string) => s.replace(REF_TAG, (whole, id: string) => (rename.has(id) ? `[${rename.get(id)}]` : whole));
    if (dossier.notes.trim()) notes.push(retag(dossier.notes.trim()));
    for (const v of dossier.versions) {
      const item = { ...v, ref: rename.get(v.ref) ?? v.ref };
      const k = `${item.tech}\u0000${item.versionSeen}`;
      if (seen.versions.has(k)) continue;
      seen.versions.add(k);
      merged.versions.push(item);
    }
    for (const a of dossier.apis) {
      const item = { ...a, ref: rename.get(a.ref) ?? a.ref };
      if (seen.apis.has(item.symbol)) continue;
      seen.apis.add(item.symbol);
      merged.apis.push(item);
    }
    for (const t of dossier.toolchain) {
      const item = { ...t, ref: rename.get(t.ref) ?? t.ref };
      const k = `${item.tool}\u0000${item.install}`;
      if (seen.toolchain.has(k)) continue;
      seen.toolchain.add(k);
      merged.toolchain.push(item);
    }
  }

  merged.notes = notes.join('\n\n');
  return ResearchDossier.parse(merged);
}
