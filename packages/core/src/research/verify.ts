import type { ResearchDossier } from '../schemas/research.js';
import { MAX_CITED_CHARS } from '../schemas/research.js';
import { REF_TAG } from './dossier.js';
import { isAllowedUrl } from './sources.js';

/**
 * Grounding checks on a dossier (docs/project-learner.md §7). Pure.
 *
 * `verifyDossier` holds research to its allowlist (invariant 23) and to its
 * own citations: every reference is on the list (or unvetted under
 * `general`), every candidate has a reference, and no note line lacks one.
 */

export type DossierRule = 'off-list' | 'unvetted' | 'missing-candidate' | 'untagged-line' | 'unknown-ref' | 'long-snippet';

export interface DossierViolation {
  rule: DossierRule;
  detail: string;
}

export interface VerifyDossierInput {
  /** The call's allowlist; null under `general`, where references must be unvetted. */
  allowedDomains: string[] | null;
  /** Research keys that must each have a `# key` section with a reference. */
  candidates: string[];
}

export function verifyDossier(dossier: ResearchDossier, input: VerifyDossierInput): DossierViolation[] {
  const violations: DossierViolation[] = [];
  const ids = new Set(dossier.docRefs.map((r) => r.id));

  for (const ref of dossier.docRefs) {
    if (input.allowedDomains === null) {
      if (ref.vetted) violations.push({ rule: 'unvetted', detail: `${ref.id} ${ref.url} has no allowlist to be vetted against` });
    } else if (!isAllowedUrl(ref.url, input.allowedDomains)) {
      violations.push({ rule: 'off-list', detail: `${ref.id} ${ref.url}` });
    }
    if (ref.citedText.length > MAX_CITED_CHARS) {
      violations.push({ rule: 'long-snippet', detail: `${ref.id} quotes ${ref.citedText.length} characters` });
    }
  }

  const sectionRefs = new Map<string, number>();
  let section = '';
  for (const raw of dossier.notes.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#\s/.test(line)) {
      section = line.slice(1).trim().toLowerCase();
      sectionRefs.set(section, sectionRefs.get(section) ?? 0);
      continue;
    }
    if (/^##\s/.test(line)) continue;
    const tags = [...line.matchAll(REF_TAG)].map((m) => m[1]!);
    if (tags.length === 0) {
      violations.push({ rule: 'untagged-line', detail: line.slice(0, 80) });
      continue;
    }
    for (const tag of tags) {
      if (!ids.has(tag)) violations.push({ rule: 'unknown-ref', detail: `[${tag}] in "${line.slice(0, 60)}"` });
    }
    sectionRefs.set(section, (sectionRefs.get(section) ?? 0) + 1);
  }

  for (const key of input.candidates) {
    if (!sectionRefs.get(key.toLowerCase())) violations.push({ rule: 'missing-candidate', detail: key });
  }

  return violations;
}
