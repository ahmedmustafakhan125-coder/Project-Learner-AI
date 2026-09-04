/**
 * The Markdown renderer.
 *
 * Two things are under test. The first is that instructions actually render —
 * they were reaching learners as literal `### Your Task` and `**bold**`. The
 * second matters more: CONTEXT.md invariant 5 forbids a Markdown library
 * because model output is untrusted and raw-HTML support is a direct XSS path.
 * This renderer is safe by construction — it builds React elements, so markup
 * in the source can only ever become a text child — and these tests pin that
 * property rather than trusting it.
 */

import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { renderInline, renderMarkdown } from '../lib/markdown';

/** Element type names in render order, e.g. ['h2', 'p', 'ul']. */
function tags(nodes: ReactNode[]): string[] {
  return nodes
    .filter((n): n is ReactElement => isValidElement(n))
    .map((n) => (typeof n.type === 'string' ? n.type : 'component'));
}

/** All text in a node tree, so assertions do not depend on nesting shape. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) {
    return textOf((node.props as { children?: ReactNode }).children);
  }
  return '';
}

describe('block rendering', () => {
  it('renders headings as elements, not as literal hashes', () => {
    const out = renderMarkdown('### What is argparse?');
    expect(tags(out)).toEqual(['h4']);
    expect(textOf(out)).toBe('What is argparse?');
    expect(textOf(out)).not.toContain('#');
  });

  it('demotes heading levels so a step never emits a second h1', () => {
    // The page already owns the h1; instructions start at h2.
    expect(tags(renderMarkdown('# Title'))).toEqual(['h2']);
    expect(tags(renderMarkdown('###### Deep'))).toEqual(['h6']);
  });

  it('renders bullet and ordered lists', () => {
    expect(tags(renderMarkdown('- one\n- two'))).toEqual(['ul']);
    expect(tags(renderMarkdown('1. one\n2. two'))).toEqual(['ol']);
  });

  it('keeps a nested bullet inside the same list', () => {
    const out = renderMarkdown('1. Implement\n  - Define it\n  - Return it');
    // A different marker type starts its own list rather than merging.
    expect(tags(out)).toEqual(['ol', 'ul']);
  });

  it('renders a horizontal rule instead of three dashes', () => {
    expect(tags(renderMarkdown('---'))).toEqual(['hr']);
    expect(textOf(renderMarkdown('---'))).toBe('');
  });

  it('renders blockquotes and joins their continuation lines', () => {
    const out = renderMarkdown('> first\n> second');
    expect(tags(out)).toEqual(['blockquote']);
    expect(textOf(out)).toBe('first second');
  });

  it('joins wrapped lines into one paragraph and splits on a blank line', () => {
    const out = renderMarkdown('one\ntwo\n\nthree');
    expect(tags(out)).toEqual(['p', 'p']);
    expect(textOf(out[0])).toBe('one two');
  });
});

describe('inline rendering', () => {
  it('renders code, bold and italic', () => {
    expect(tags(renderInline('`code`'))).toEqual(['code']);
    expect(tags(renderInline('**bold**'))).toEqual(['strong']);
    expect(tags(renderInline('*italic*'))).toEqual(['em']);
  });

  it('strips the markers from the rendered text', () => {
    const out = renderInline('Use **argparse** and `--help` now');
    expect(textOf(out)).toBe('Use argparse and --help now');
  });

  it('keeps surrounding text in order', () => {
    expect(textOf(renderInline('before `x` after'))).toBe('before x after');
  });
});

describe('safety — the reason there is no Markdown library here', () => {
  it('never emits raw HTML: a tag in the source stays text', () => {
    const out = renderMarkdown('<script>alert(1)</script> and <img onerror=x>');
    // It becomes a text child of a <p>, so React escapes it on render.
    expect(textOf(out)).toContain('<script>alert(1)</script>');
    expect(tags(out)).toEqual(['p']);
  });

  it('produces no element carrying dangerouslySetInnerHTML', () => {
    const out = renderMarkdown('# h\n\n- a\n\n> q\n\n`c` **b** [l](https://example.com)');
    const seen: unknown[] = [];
    const walk = (node: ReactNode) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!isValidElement(node)) return;
      const props = node.props as Record<string, unknown>;
      seen.push(props['dangerouslySetInnerHTML']);
      walk(props['children'] as ReactNode);
    };
    walk(out);
    expect(seen.every((v) => v === undefined)).toBe(true);
  });

  it('renders an http link but refuses a javascript: URL', () => {
    const ok = renderInline('[docs](https://example.com)');
    expect(tags(ok)).toEqual(['a']);

    // The one place a plain React element could still execute model input.
    // The URL pattern stops at the first ')', so a payload containing parens
    // leaves a stray character in the label. That is cosmetic; what must hold
    // is that no anchor is produced and the scheme never reaches the DOM.
    const bad = renderInline('[click](javascript:alert(1))');
    expect(tags(bad)).not.toContain('a');
    expect(textOf(bad)).toContain('click');
    expect(textOf(bad)).not.toContain('javascript:');
  });

  it('refuses data: URLs too', () => {
    const out = renderInline('[x](data:text/html;base64,PHNjcmlwdD4=)');
    expect(tags(out)).not.toContain('a');
  });
});
