import { Fragment, type ReactNode } from 'react';

/**
 * A deliberately small Markdown renderer that emits React elements.
 *
 * CONTEXT.md invariant 5: the UI must not use a Markdown library, because model
 * output is untrusted and any renderer with raw-HTML support is a direct XSS
 * path. That rule is about *raw HTML*, not about formatting — instructions
 * arriving as literal `### Your Task` and `**bold**` help nobody.
 *
 * So this parses the subset the generator actually emits and builds React nodes
 * from it. There is no `dangerouslySetInnerHTML` anywhere, and no HTML parsing:
 * anything that looks like a tag stays text, because it only ever becomes a
 * text child. That is what makes it safe by construction rather than by
 * sanitising.
 *
 * Supported: headings, bullet and ordered lists, blockquotes, horizontal rules,
 * paragraphs, and inline code / bold / italic / links. Fenced code blocks are
 * handled by the caller, which already splits them out so they can be rendered
 * with a copy button.
 */

/* ------------------------------------------------------------------ *
 * Inline
 * ------------------------------------------------------------------ */

/**
 * Only http(s) and mailto survive. A `javascript:` href is the one place a
 * plain React element could still execute model-supplied input.
 */
function safeHref(raw: string): string | null {
  const url = raw.trim();
  return /^(https?:\/\/|mailto:)/i.test(url) ? url : null;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))/g;

export function renderInline(text: string, keyPrefix = ''): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  INLINE.lastIndex = 0;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > cursor) out.push(text.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyPrefix}i${i++}`;

    if (token.startsWith('`')) {
      out.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*')) {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const split = token.indexOf('](');
      const label = token.slice(1, split);
      const href = safeHref(token.slice(split + 2, -1));
      out.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer">
            {label}
          </a>
        ) : (
          // Refused scheme: show the label as plain text rather than a dead link.
          <Fragment key={key}>{label}</Fragment>
        ),
      );
    }
    cursor = match.index + token.length;
  }

  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

/* ------------------------------------------------------------------ *
 * Blocks
 * ------------------------------------------------------------------ */

const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*(---+|\*\*\*+|___+)\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;

/** Indent depth in levels, so nested bullets keep their shape. */
function depthOf(line: string): number {
  const spaces = line.length - line.trimStart().length;
  return Math.min(Math.floor(spaces / 2), 3);
}

export function renderMarkdown(source: string, keyPrefix = 'md'): ReactNode[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let paragraph: string[] = [];
  let key = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(' ').trim();
    paragraph = [];
    if (text) out.push(<p key={`${keyPrefix}p${key++}`}>{renderInline(text, `${keyPrefix}p${key}`)}</p>);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    const rule = RULE.exec(line);
    if (rule) {
      flushParagraph();
      out.push(<hr key={`${keyPrefix}hr${key++}`} />);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      const level = Math.min(heading[1]!.length, 6);
      const Tag = `h${Math.min(level + 1, 6)}` as 'h2';
      out.push(
        <Tag key={`${keyPrefix}h${key++}`}>{renderInline(heading[2] ?? '', `${keyPrefix}h${key}`)}</Tag>,
      );
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flushParagraph();
      const collected = [quote[1] ?? ''];
      while (i + 1 < lines.length && QUOTE.test(lines[i + 1] ?? '')) {
        collected.push(QUOTE.exec(lines[++i] ?? '')?.[1] ?? '');
      }
      out.push(
        <blockquote key={`${keyPrefix}q${key++}`}>
          {renderInline(collected.join(' '), `${keyPrefix}q${key}`)}
        </blockquote>,
      );
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      flushParagraph();
      const ordered = ORDERED.test(line);
      const items: { depth: number; text: string }[] = [];

      while (i < lines.length) {
        const current = lines[i] ?? '';
        const bulletMatch = BULLET.exec(current);
        const orderedMatch = ORDERED.exec(current);
        if (!bulletMatch && !orderedMatch) break;
        // A different marker type starts a new list rather than continuing this one.
        if (Boolean(orderedMatch) !== ordered) break;
        items.push({
          depth: depthOf(current),
          text: (orderedMatch ? orderedMatch[2] : bulletMatch?.[1]) ?? '',
        });
        i++;
      }
      i--;

      const ListTag = ordered ? 'ol' : 'ul';
      const base = Math.min(...items.map((it) => it.depth));
      out.push(
        <ListTag key={`${keyPrefix}l${key++}`}>
          {items.map((item, n) => (
            <li key={n} style={item.depth > base ? { marginLeft: (item.depth - base) * 16 } : undefined}>
              {renderInline(item.text, `${keyPrefix}l${key}n${n}`)}
            </li>
          ))}
        </ListTag>,
      );
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  return out;
}
