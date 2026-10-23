import type { DocRef } from '@ai-edu/core';

import { hostOf, safeHref } from '../lib/stackBrief';

/**
 * The documentation a brief rests on. Each entry links to the page itself;
 * the brief paraphrases and links rather than quoting (§7).
 */
export function SourcesList({ sources, heading = 'Sources' }: { sources: DocRef[]; heading?: string | null }) {
  const linkable = sources.filter((s) => safeHref(s.url) !== null);
  if (linkable.length === 0) return null;
  return (
    <div className="sources">
      {heading && <h3>{heading}</h3>}
      <ul className="sources-list">
        {linkable.map((source) => (
          <li key={source.id}>
            <a href={safeHref(source.url)!} target="_blank" rel="noopener noreferrer">
              {source.title || hostOf(source.url)}
            </a>
            <span className="muted"> {hostOf(source.url)}</span>
            {!source.vetted && (
              <span className="source-unvetted" title="Not on the list of official documentation sites">
                unvetted
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
