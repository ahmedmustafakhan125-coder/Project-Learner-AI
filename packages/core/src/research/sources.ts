import type { ServerToolSpec } from '@ai-edu/llm';
import { z } from 'zod';

import type { DocSourceKey, Profile } from '../profiles/types.js';

/**
 * The doc-source registry (`knowledge/docs/sources.json`, §7) and the tech
 * cards (`knowledge/tech/*.md`), as data. apps/api reads both off disk at
 * startup; everything here works on what it already loaded.
 *
 * The research pass's allowlist is built from the registry and nothing else
 * (invariant 23): the union of `base`, the profile's entry and each candidate
 * technology's entry.
 */

export const DocSourceEntry = z.object({
  domains: z.array(z.string()).default([]),
  /** Where research starts. Sent in the user turn: web fetch reads only URLs it has seen. */
  entry: z.array(z.string().url()).default([]),
  /** Domains to keep out when no allowlist is possible (the general profile). */
  blocked: z.array(z.string()).default([]),
  licence: z.literal('link-and-paraphrase').optional(),
});
export type DocSourceEntry = z.infer<typeof DocSourceEntry>;

export const DocSourceRegistry = z
  .record(z.string(), z.unknown())
  .transform((raw) => {
    const out: Record<string, DocSourceEntry> = {};
    for (const [key, value] of Object.entries(raw)) {
      // `$comment` and other `$` keys are notes for the people who edit the file.
      if (key.startsWith('$')) continue;
      out[key] = DocSourceEntry.parse(value);
    }
    return out;
  });
export type DocSourceRegistry = z.infer<typeof DocSourceRegistry>;

/** A curated tech card: offline, free and reviewed (§7, source 1). */
export const TechCard = z.object({
  /** `tauri`, `x86-64-cross`: the research key it covers. */
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  title: z.string(),
  /** One plain sentence: what the tool is. */
  description: z.string(),
  /** Other names a learner might use for it, lowercase. */
  aliases: z.array(z.string()).default([]),
  /** Layer ids it can fill, across profiles. */
  layers: z.array(z.string()).default([]),
  /** The pinned major version, or null when nobody has pinned one. */
  pin: z.string().nullable().default(null),
  /** ISO date the pin and links were last reviewed. */
  pinnedOn: z.string(),
  /** The docs entry URL. */
  docs: z.string().url(),
  pros: z.array(z.string()).default([]),
  cons: z.array(z.string()).default([]),
  install: z
    .object({ linux: z.string().optional(), macos: z.string().optional(), windows: z.string().optional() })
    .default({}),
  status: z.enum(['draft', 'stable', 'deprecated']).default('stable'),
  body: z.string().default(''),
});
export type TechCard = z.infer<typeof TechCard>;

/** Cards older than this are not fresh: the pins are refreshed monthly (§7). */
export const CARD_FRESH_DAYS = 30;

export function isFreshCard(card: TechCard, now: Date): boolean {
  const reviewed = Date.parse(card.pinnedOn);
  if (Number.isNaN(reviewed) || card.status === 'deprecated') return false;
  return now.getTime() - reviewed <= CARD_FRESH_DAYS * 24 * 60 * 60 * 1000;
}

/* ------------------------------------------------------------------ *
 * Allowlist
 * ------------------------------------------------------------------ */

export interface ResearchScope {
  /** Hosts, optionally with a path prefix. Null under `general`, which has none. */
  allowedDomains: string[] | null;
  /** Only when there is no allowlist; the API takes one list or the other. */
  blockedDomains: string[];
  /** Entry URLs, for the user turn. */
  entryUrls: string[];
  /** False under `general`: what it finds is badged as unvetted. */
  vetted: boolean;
}

/**
 * What a research call may read. Under `general` there is no allowlist to
 * build, so the call keeps known low-quality sites out instead and every
 * reference it finds is unvetted.
 */
export function researchScope(registry: DocSourceRegistry, profile: Profile, keys: string[]): ResearchScope {
  const sourceKeys: DocSourceKey[] = [...profile.docSources.map((d) => d.key), ...keys.map((k) => `tech:${k}` as const)];
  const entries = sourceKeys.map((k) => registry[k]).filter((e): e is DocSourceEntry => e !== undefined);
  const unique = (values: string[]) => [...new Set(values.map((v) => v.trim()).filter(Boolean))];

  const entryUrls = unique(entries.flatMap((e) => e.entry));
  if (profile.id === 'general') {
    return {
      allowedDomains: null,
      blockedDomains: unique(entries.flatMap((e) => e.blocked)).sort(),
      entryUrls,
      vetted: false,
    };
  }
  return {
    allowedDomains: unique(entries.flatMap((e) => e.domains)).sort(),
    blockedDomains: [],
    entryUrls,
    vetted: true,
  };
}

/** Project research: 3 searches, 4 fetches, 8,000 tokens per page (§7, §11). */
export const PROJECT_RESEARCH_BUDGET = { searches: 3, fetches: 4, maxContentTokens: 8_000 } as const;

export interface ResearchBudget {
  searches: number;
  fetches: number;
  maxContentTokens: number;
}

/** The server tools for one research call, built only from its scope. */
export function researchTools(scope: ResearchScope, budget: ResearchBudget = PROJECT_RESEARCH_BUDGET): ServerToolSpec[] {
  const domains = scope.allowedDomains
    ? { allowedDomains: scope.allowedDomains }
    : scope.blockedDomains.length
      ? { blockedDomains: scope.blockedDomains }
      : {};
  return [
    { kind: 'web_search', maxUses: budget.searches, ...domains },
    { kind: 'web_fetch', maxUses: budget.fetches, ...domains, maxContentTokens: budget.maxContentTokens, citations: true },
  ];
}

/** `https://www.qemu.org/docs/master/` to `{ host: 'www.qemu.org', path: '/docs/master/' }`. */
export function splitUrl(url: string): { host: string; path: string } | null {
  const match = /^https?:\/\/([^/?#@]+)([^?#]*)/i.exec(url.trim());
  if (!match) return null;
  return { host: match[1]!.toLowerCase().replace(/:\d+$/, ''), path: match[2] || '/' };
}

/**
 * Whether a URL is on an allowlist. An entry matches its host and any
 * subdomain of it; an entry with a path matches only below that path.
 */
export function isAllowedUrl(url: string, allowedDomains: string[]): boolean {
  const parts = splitUrl(url);
  if (!parts) return false;
  return allowedDomains.some((entry) => {
    const slash = entry.indexOf('/');
    const host = (slash === -1 ? entry : entry.slice(0, slash)).toLowerCase();
    const path = slash === -1 ? '' : entry.slice(slash);
    const hostOk = parts.host === host || parts.host.endsWith(`.${host}`);
    return hostOk && (path === '' || parts.path === path || parts.path.startsWith(path.endsWith('/') ? path : `${path}/`));
  });
}
