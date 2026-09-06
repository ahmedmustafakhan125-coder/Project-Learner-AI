import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Invariants in the stylesheet that are cheap to state and expensive to notice.
 *
 * Both of these shipped, and neither was visible as a broken layout or a failing
 * test — they looked like design decisions until someone said otherwise.
 */

const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../app/globals.css'),
  'utf-8',
);

describe('background artwork that is meant to reach the edges', () => {
  /*
   * An inline SVG with a viewBox has an intrinsic aspect ratio, and the default
   * `preserveAspectRatio: xMidYMid meet` FITS it inside the background box
   * rather than filling it. Sized `100% <fixed>px`, the artwork stops scaling
   * once its own width is reached and sits centred, exposing the page
   * background as a hard vertical strip down each side.
   *
   * That is what made the pages look like they were drawn inside a narrower
   * page: the 1440x450 wave stopped at 1440px, so a 1920px viewport showed
   * (1920 - 1440) / 2 = 240px of background on the left and the right.
   *
   * Anything sized to a percentage width has to opt out of that.
   */
  const percentSized = [...css.matchAll(/background-size:([^;]+);/g)].flatMap((m) =>
    m[1].split(',').map((s) => s.trim()),
  );

  it('has at least one percentage-width layer, or this test is watching nothing', () => {
    expect(percentSized.some((s) => s.startsWith('100%'))).toBe(true);
  });

  it('tells every viewBox SVG used as full-width artwork to stretch', () => {
    // Every inline SVG carrying a viewBox whose width is a percentage of the
    // box must say so explicitly; `meet` would letterbox it.
    const waves = [...css.matchAll(/viewBox%3D%22[^%]*%20[^%]*%20(\d+)%20(\d+)%22([^)]*?)%3E/g)];
    expect(waves.length).toBeGreaterThan(0);

    const fullBleed = waves.filter(([, w]) => Number(w) >= 1000);
    expect(fullBleed.length).toBeGreaterThan(0);
    for (const [, , , attrs] of fullBleed) {
      expect(attrs).toContain('preserveAspectRatio%3D%22none%22');
    }
  });
});

describe('text colours on a white surface', () => {
  const relativeLuminance = (hex: string): number => {
    const channels = [1, 3, 5].map((i) => {
      const v = parseInt(hex.substr(i, 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  };

  const contrastOnWhite = (hex: string): number => (1.0 + 0.05) / (relativeLuminance(hex) + 0.05);

  /*
   * Read line-wise rather than with a built regex. A `\s` written inside a
   * template literal is not an escape JavaScript knows, so it collapses to a
   * bare `s` and the pattern silently stops matching — which is how the first
   * version of this test failed on four correct colours.
   */
  const tokenValue = (name: string): string => {
    const prefix = `--${name}:`;
    const line = css
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith(prefix));
    expect(line, `--${name} should be declared`).toBeDefined();

    const hex = line!.slice(prefix.length).trim().replace(/;$/, '');
    expect(hex, `--${name} should be a six-digit hex`).toMatch(/^#[0-9a-fA-F]{6}$/);
    return hex;
  };

  /*
   * `--text-faint` was #94a3b8: 2.56:1 on white, below even the 3:1 floor for
   * large text. It is used for real prose in fifteen places, and the report was
   * simply that it could not be read.
   */
  it.each(['text', 'text-dim', 'text-faint'])('--%s clears WCAG AA on white', (name) => {
    expect(contrastOnWhite(tokenValue(name))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the faint step lighter than the dim one', () => {
    // Otherwise the palette has two names for one colour, and the next person
    // to reach for `--text-faint` gets no hierarchy from it.
    expect(contrastOnWhite(tokenValue('text-faint'))).toBeLessThan(
      contrastOnWhite(tokenValue('text-dim')),
    );
  });
});
