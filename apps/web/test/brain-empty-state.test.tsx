/**
 * What the brain page says when there is nothing to draw.
 *
 * A new account and a server that does not have the brain both produce an
 * empty page, and both used to say the wrong thing: a raw "Route GET:… not
 * found", or "Nothing in this window yet" to someone who has never learned
 * anything here. These pin the four situations apart.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@ai-edu/api-client';

import { BrainEmptyState, emptyVariantFor, errorVariantFor } from '../components/brain/BrainEmptyState';

const meta = (brainSize: number | undefined) => ({
  meta: { total: 0, truncated: false, focus: null, ...(brainSize === undefined ? {} : { brainSize }) },
});

describe('emptyVariantFor', () => {
  it('a brain with no nodes at all is a new brain, whatever the window', () => {
    expect(emptyVariantFor(meta(0) as never, 90)).toBe('new');
    expect(emptyVariantFor(meta(0) as never, null)).toBe('new');
  });

  it('a brain with nodes outside the window is an empty window', () => {
    expect(emptyVariantFor(meta(12) as never, 30)).toBe('window');
  });

  it('without the size (an older server), a window means it may just be older activity', () => {
    expect(emptyVariantFor(meta(undefined) as never, 90)).toBe('window');
    expect(emptyVariantFor(meta(undefined) as never, null)).toBe('new');
  });
});

describe('errorVariantFor', () => {
  it('a 404 is a server without the brain, not a broken brain', () => {
    const notFound = new ApiError(404, 'Not Found', 'Route GET:/api/brain/graph?window=90&depth=2 not found');
    expect(errorVariantFor(notFound)).toBe('unavailable');
  });

  it('anything else is an error to retry', () => {
    expect(errorVariantFor(new ApiError(500, 'brain_unavailable', 'boom'))).toBe('error');
    expect(errorVariantFor(new TypeError('Failed to fetch'))).toBe('error');
  });
});

describe('BrainEmptyState', () => {
  it('a new brain says no network has formed yet, and how to start one', () => {
    const html = renderToStaticMarkup(<BrainEmptyState variant="new" />);
    expect(html).toContain('No neural network formed yet');
    expect(html).toContain('href="/ask"');
    expect(html).toContain('href="/projects/new"');
    // The dormant network is decoration, hidden from screen readers.
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it('an empty window offers all of time', () => {
    const html = renderToStaticMarkup(<BrainEmptyState variant="window" onShowAllTime={() => {}} />);
    expect(html).toContain('Nothing in this window yet');
    expect(html).toContain('Show all time');
  });

  it('a server without the brain says so in plain words — never the raw route', () => {
    const html = renderToStaticMarkup(<BrainEmptyState variant="unavailable" onRetry={() => {}} />);
    expect(html).toContain('isn’t available yet');
    expect(html).toContain('Try again');
    expect(html).not.toMatch(/Route|GET|404|not found/);
  });

  it('a failed load offers a retry', () => {
    const html = renderToStaticMarkup(<BrainEmptyState variant="error" onRetry={() => {}} />);
    expect(html).toContain('couldn’t be loaded');
    expect(html).toContain('Try again');
  });
});
