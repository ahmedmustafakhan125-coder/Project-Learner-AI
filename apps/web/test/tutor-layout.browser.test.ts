/**
 * The tutor drawer, measured in a real browser.
 *
 * The reported bug: a CMake answer arrived with
 * `GIT_REPOSITORY https://github.com/glfw/glfw` cut off mid-URL behind a 4px
 * horizontal scrollbar. `.answer pre` is `white-space: pre` with
 * `overflow-x: auto`, which is correct in an 800px column and wrong in a 400px
 * drawer — the learner could not read a repository address without dragging a
 * scrollbar inside a scrollbar.
 *
 * Clipping is a layout fact, not a source fact, so it is checked the only way
 * that can actually fail: lay the panel out in Chrome at the width the learner
 * had, put the content that broke it inside, and measure. A unit test on the
 * stylesheet text would pass on a rule that does nothing.
 *
 * Each assertion below fails against the previous stylesheet.
 */

import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';

import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BROWSER_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findBrowser(): string {
  const found = BROWSER_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new Error('No Chrome or Edge found. Looked in:\n' + BROWSER_CANDIDATES.join('\n'));
  }
  return found;
}

/*
 * The real stylesheet, minus its webfont import.
 *
 * Stripping the import keeps the suite offline. It costs nothing here: every
 * rule under test is about box geometry, and none of them depends on which
 * font is loaded — only on there being one, which the fallback stack provides.
 */
const CSS = readFileSync('app/globals.css', 'utf8').replace(/@import url\([^)]*\);/g, '');

const ANSWER_CODE = [
  'FetchContent_Declare(',
  '    glfw',
  '    GIT_REPOSITORY https://github.com/glfw/glfw.git',
  '    GIT_TAG        3.3.8',
  ')',
  'FetchContent_MakeAvailable(glfw)',
].join('\n');

/**
 * The panel's markup, matching ProjectTutor.tsx.
 *
 * A static copy rather than a React render, so the suite stays a plain browser
 * harness. `the fixture matches the component` below reads the component source
 * and fails if this drifts from it.
 */
const PANEL = `
<aside class="tutor-panel" aria-label="Project tutor" id="panel">
  <div class="tutor-resize" id="grip" role="separator" aria-orientation="vertical" tabindex="0"></div>
  <button type="button" class="tutor-close-handle"><span>&rsaquo;</span></button>
  <div class="tutor-body">
    <header class="tutor-head">
      <span class="tutor-title"><span>&#10022;</span> Tutor</span>
      <button type="button" class="tutor-collapse">&#10005;</button>
    </header>
    <div class="tutor-log" id="log">
      <div class="tutor-turn tutor-turn-user">
        <span class="tutor-who">You</span>
        <p class="tutor-text" id="userturn">Use FetchContent to download https://github.com/ocornut/imgui.git at tag v1.89.9</p>
      </div>
      <div class="tutor-turn tutor-turn-assistant">
        <span class="tutor-who">Tutor</span>
        <div class="tutor-text answer">
          <div><p>Your <code id="chip">FetchContent_MakeAvailable(glfw)</code> declaration in <code>CMakeLists.txt</code> is already set up.</p></div>
          <pre id="fence"><code>${ANSWER_CODE}</code></pre>
        </div>
      </div>
    </div>
    <div class="tutor-gate unlocked" id="gate">
      <strong>Code is open on this step.</strong>
      <span class="muted"> Ask for the part you are stuck on.</span>
    </div>
    <div class="tutor-composer" id="composer">
      <textarea rows="2" placeholder="Ask about step 1..."></textarea>
      <button type="button" class="btn primary">Ask</button>
    </div>
  </div>
</aside>`;

/**
 * The navigation bar, as `NavHeader` renders it.
 *
 * Present because the reported bug is an interaction between the two: the bar
 * is `rgba(255,255,255,0.85)` with a backdrop blur, so when the drawer ran
 * underneath it the drawer's header showed THROUGH the bar as a smear. A
 * fixture without a bar cannot see that, which is why the first version of
 * this suite passed while the bug was still on screen.
 */
const NAVBAR = `
<header class="lumina-navbar" id="navbar">
  <div class="lumina-nav-container">
    <a class="lumina-brand" href="/">Project Learner</a>
    <nav class="lumina-nav-links"><a class="lumina-nav-link" href="/projects">Projects</a></nav>
    <div class="lumina-nav-actions" id="navactions">
      <span class="user-chip">admin</span>
      <button type="button" class="btn-nav-signin">Sign out</button>
    </div>
  </div>
</header>`;

const PAGE = `<!DOCTYPE html><html><head><style>${CSS}</style></head>
<body>${NAVBAR}<main style="height:3000px">page content behind the drawer</main>${PANEL}</body></html>`;

let server: Server;
let browser: Browser;
let origin: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ executablePath: findBrowser() });
}, 150_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

/** The drawer at the width it shipped with, in the window it was reported in. */
async function openPanel(width = 1920, height = 900): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(origin, { waitUntil: 'load' });
  return page;
}

/** How much of an element is cut off horizontally. Zero is the whole point. */
const overflowOf = (page: Page, id: string) =>
  page.evaluate((sel) => {
    const el = document.getElementById(sel)!;
    return el.scrollWidth - el.clientWidth;
  }, id);

/**
 * The narrowest the drawer can be dragged, which is the case that matters.
 *
 * Assertions about clipping are worth most at the worst width: content that
 * fits at 400px says nothing about 320px, and 320px is a width the learner can
 * actually choose. It also keeps the mutation check below honest - the drawer
 * grew 26px when the close strip became a floating tab, and at the wider size
 * the old `white-space: pre` happened to fit this particular block, so the
 * check quietly stopped proving anything.
 */
const MIN_DRAWER = 320;
const narrow = (page: Page) =>
  page.evaluate((px) => {
    document.getElementById('panel')!.style.setProperty('--tutor-w', `${px}px`);
  }, MIN_DRAWER);

describe('fenced code in an answer', () => {
  it('is not cut off at the edge of the drawer', async () => {
    const page = await openPanel();
    // The bug, measured: this was ~150px of hidden URL.
    expect(await overflowOf(page, 'fence')).toBeLessThanOrEqual(1);
    await page.close();
  });

  it('shows the whole repository URL, not a prefix of it', async () => {
    const page = await openPanel();
    const cut = await page.evaluate(() => {
      const pre = document.getElementById('fence')!;
      const box = pre.getBoundingClientRect();
      // Walk the text and find any character box past the right edge.
      const range = document.createRange();
      const text = pre.firstChild!.firstChild as Text;
      let worst = 0;
      for (let i = 0; i < text.length; i++) {
        range.setStart(text, i);
        range.setEnd(text, i + 1);
        const r = range.getBoundingClientRect();
        if (r.width > 0) worst = Math.max(worst, r.right - box.right);
      }
      return worst;
    });
    expect(cut).toBeLessThanOrEqual(1);
    await page.close();
  });

  it('needs no horizontal scrollbar to read it', async () => {
    const page = await openPanel();
    const scrollable = await page.evaluate(() => {
      const pre = document.getElementById('fence')!;
      return pre.scrollWidth > pre.clientWidth;
    });
    expect(scrollable).toBe(false);
    await page.close();
  });

  it('is not cut off at the narrowest width either', async () => {
    const page = await openPanel();
    await narrow(page);
    expect(await overflowOf(page, 'fence')).toBeLessThanOrEqual(1);
    await page.close();
  });

  it('still clips under the old rule, so this test knows what it protects', async () => {
    // If `white-space: pre` stops clipping on its own, the fix above has become
    // decorative and someone should find out why before deleting it.
    const page = await openPanel();
    await narrow(page);
    await page.evaluate(() => {
      const pre = document.getElementById('fence')!;
      pre.style.whiteSpace = 'pre';
      pre.style.overflowX = 'auto';
    });
    expect(await overflowOf(page, 'fence')).toBeGreaterThan(20);
    await page.close();
  });
});

describe('prose beside it', () => {
  it('keeps a long inline code chip inside the panel', async () => {
    const page = await openPanel();
    const escaped = await page.evaluate(() => {
      const panel = document.getElementById('panel')!.getBoundingClientRect();
      const chip = document.getElementById('chip')!.getBoundingClientRect();
      return chip.right - panel.right;
    });
    expect(escaped).toBeLessThanOrEqual(1);
    await page.close();
  });

  it('wraps a bare URL the learner pasted', async () => {
    const page = await openPanel();
    expect(await overflowOf(page, 'userturn')).toBeLessThanOrEqual(1);
    await page.close();
  });

  it('leaves nothing at all hanging off the right edge', async () => {
    const page = await openPanel();
    const strays = await page.evaluate(() => {
      const panel = document.getElementById('panel')!;
      const edge = panel.getBoundingClientRect().right;
      return [...panel.querySelectorAll('*')]
        .filter((el) => el.getBoundingClientRect().right - edge > 1)
        .map((el) => el.className || el.tagName);
    });
    expect(strays).toEqual([]);
    await page.close();
  });
});

describe('the vertical layout', () => {
  it('puts the composer on screen, not below the fold', async () => {
    const page = await openPanel();
    const overhang = await page.evaluate(
      () => document.getElementById('composer')!.getBoundingClientRect().bottom - window.innerHeight,
    );
    expect(overhang).toBeLessThanOrEqual(1);
    await page.close();
  });

  it('still does on a short window, where the furniture used to be squeezed', async () => {
    const page = await openPanel(1280, 420);
    const { overhang, gateHeight } = await page.evaluate(() => {
      const composer = document.getElementById('composer')!;
      const gate = document.getElementById('gate')!;
      return {
        overhang: composer.getBoundingClientRect().bottom - window.innerHeight,
        gateHeight: gate.getBoundingClientRect().height,
      };
    });
    expect(overhang).toBeLessThanOrEqual(1);
    // Not merely on screen: not crushed to get there. `flex: 0 0 auto` is what
    // makes the transcript give way instead of the gate line.
    expect(gateHeight).toBeGreaterThan(20);
    await page.close();
  });

  it('scrolls the transcript and nothing else', async () => {
    const page = await openPanel(1280, 420);
    const { panelOverflow, logScrolls } = await page.evaluate(() => {
      const panel = document.getElementById('panel')!;
      const log = document.getElementById('log')!;
      return {
        panelOverflow: panel.scrollHeight - panel.clientHeight,
        logScrolls: log.scrollHeight > log.clientHeight,
      };
    });
    expect(panelOverflow).toBeLessThanOrEqual(1);
    expect(logScrolls).toBe(true);
    await page.close();
  });
});

describe('the resize grip', () => {
  it('sets the panel width from --tutor-w', async () => {
    const page = await openPanel();
    const width = await page.evaluate(() => {
      const panel = document.getElementById('panel')!;
      panel.style.setProperty('--tutor-w', '640px');
      return panel.getBoundingClientRect().width;
    });
    expect(width).toBe(640);
    await page.close();
  });

  it('gives long code more room without ever needing to', async () => {
    const page = await openPanel();
    const overflow = await page.evaluate(() => {
      const panel = document.getElementById('panel')!;
      panel.style.setProperty('--tutor-w', '720px');
      const pre = document.getElementById('fence')!;
      return pre.scrollWidth - pre.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
    await page.close();
  });

  it('is a drag target wide enough to hit', async () => {
    const page = await openPanel();
    const { width, cursor } = await page.evaluate(() => {
      const grip = document.getElementById('grip')!;
      return {
        width: grip.getBoundingClientRect().width,
        cursor: getComputedStyle(grip).cursor,
      };
    });
    expect(width).toBeGreaterThanOrEqual(4);
    expect(cursor).toBe('col-resize');
    await page.close();
  });

  it('is hidden where there is no width to give', async () => {
    const page = await openPanel(600, 800);
    const { gripShown, panelWidth } = await page.evaluate(() => ({
      gripShown: getComputedStyle(document.getElementById('grip')!).display !== 'none',
      panelWidth: document.getElementById('panel')!.getBoundingClientRect().width,
    }));
    expect(gripShown).toBe(false);
    expect(panelWidth).toBe(600);
    await page.close();
  });
});

describe('the drawer and the navigation bar', () => {
  it('starts below the bar instead of underneath it', async () => {
    // The reported bug. The bar is 85% opaque, so an overlap did not hide the
    // drawer - it blended the two, and the drawer's header read as a smudge
    // across the account buttons.
    const page = await openPanel();
    const gap = await page.evaluate(() => {
      const nav = document.getElementById('navbar')!.getBoundingClientRect();
      const panel = document.getElementById('panel')!.getBoundingClientRect();
      return panel.top - nav.bottom;
    });
    expect(gap).toBeGreaterThanOrEqual(0);
    await page.close();
  });

  it('leaves the account controls completely uncovered', async () => {
    const page = await openPanel();
    const covered = await page.evaluate(() => {
      const actions = document.getElementById('navactions')!.getBoundingClientRect();
      const panel = document.getElementById('panel')!.getBoundingClientRect();
      const overlapX = Math.min(actions.right, panel.right) - Math.max(actions.left, panel.left);
      const overlapY = Math.min(actions.bottom, panel.bottom) - Math.max(actions.top, panel.top);
      return overlapX > 0 && overlapY > 0;
    });
    expect(covered).toBe(false);
    await page.close();
  });

  it('keeps the bar pinned when the page is scrolled', async () => {
    const page = await openPanel();
    await page.evaluate(() => window.scrollTo(0, 1200));
    const { navTop, panelTop } = await page.evaluate(() => ({
      navTop: document.getElementById('navbar')!.getBoundingClientRect().top,
      panelTop: document.getElementById('panel')!.getBoundingClientRect().top,
    }));
    expect(navTop).toBe(0);
    // And the drawer stays put with it, rather than sliding up under the bar.
    expect(panelTop).toBeGreaterThanOrEqual(navTop + 60);
    await page.close();
  });

  it('does not hide the top of the page behind the pinned bar', async () => {
    // Taking the bar out of flow without reserving its height would put the
    // first line of every page underneath it.
    const page = await openPanel();
    const clear = await page.evaluate(() => {
      const nav = document.getElementById('navbar')!.getBoundingClientRect();
      const main = document.querySelector('main')!.getBoundingClientRect();
      return main.top - nav.bottom;
    });
    expect(clear).toBeGreaterThanOrEqual(0);
    await page.close();
  });

  it('reaches the bottom of the window even though it starts lower', async () => {
    const page = await openPanel();
    const short = await page.evaluate(
      () => window.innerHeight - document.getElementById('panel')!.getBoundingClientRect().bottom,
    );
    expect(Math.abs(short)).toBeLessThanOrEqual(1);
    await page.close();
  });
});

describe('the close tab', () => {
  it('is a small tab, not a full-height strip', async () => {
    const page = await openPanel();
    const { height, panelHeight, width } = await page.evaluate(() => {
      const tab = document.querySelector('.tutor-close-handle')!.getBoundingClientRect();
      const panel = document.getElementById('panel')!.getBoundingClientRect();
      return { height: tab.height, panelHeight: panel.height, width: tab.width };
    });
    expect(height).toBeLessThan(panelHeight / 3);
    expect(height).toBeGreaterThan(40);
    expect(width).toBeGreaterThanOrEqual(20);
    await page.close();
  });

  it('sits in the middle of the panel edge', async () => {
    const page = await openPanel();
    const offCentre = await page.evaluate(() => {
      const tab = document.querySelector('.tutor-close-handle')!.getBoundingClientRect();
      const panel = document.getElementById('panel')!.getBoundingClientRect();
      return Math.abs(tab.top + tab.height / 2 - (panel.top + panel.height / 2));
    });
    expect(offCentre).toBeLessThanOrEqual(1);
    await page.close();
  });

  it('hangs off the outside edge, where the page it covers is', async () => {
    const page = await openPanel();
    const protrusion = await page.evaluate(() => {
      const tab = document.querySelector('.tutor-close-handle')!.getBoundingClientRect();
      const panel = document.getElementById('panel')!.getBoundingClientRect();
      return panel.left - tab.left;
    });
    expect(protrusion).toBeGreaterThan(0);
    await page.close();
  });

  it('opens and closes in the same place, so the control does not jump', async () => {
    // The rail that opens the drawer and the tab that closes it should be the
    // same object as far as the learner is concerned.
    const page = await openPanel();
    const drift = await page.evaluate(() => {
      const tab = document.querySelector('.tutor-close-handle')!.getBoundingClientRect();
      // The rail is not rendered while the panel is open, so it is measured by
      // building one with the same class.
      const rail = document.createElement('button');
      rail.className = 'tutor-rail';
      document.body.appendChild(rail);
      const railBox = rail.getBoundingClientRect();
      rail.remove();
      return Math.abs(tab.top + tab.height / 2 - (railBox.top + railBox.height / 2));
    });
    expect(drift).toBeLessThanOrEqual(1);
    await page.close();
  });

  it('stays on screen when the drawer fills a narrow window', async () => {
    const page = await openPanel(600, 800);
    const off = await page.evaluate(
      () => document.querySelector('.tutor-close-handle')!.getBoundingClientRect().left,
    );
    expect(off).toBeGreaterThanOrEqual(0);
    await page.close();
  });
});

describe('the fixture matches the component', () => {
  it('uses class names that ProjectTutor.tsx still renders', () => {
    // A static copy of the markup is only worth measuring while it is still
    // the markup. This fails the day a class is renamed.
    const source = readFileSync('components/ProjectTutor.tsx', 'utf8');
    for (const cls of [
      'tutor-panel',
      'tutor-resize',
      'tutor-close-handle',
      'tutor-body',
      'tutor-head',
      'tutor-log',
      'tutor-turn',
      'tutor-text',
      'tutor-gate',
      'tutor-composer',
    ]) {
      expect(source, `${cls} is no longer rendered`).toContain(cls);
    }
  });

  it('keeps the empty state inside the scrolling log', () => {
    // As a sibling of the log it was a second unscrollable block in the
    // column, which is what pushed the composer off a short window.
    const source = readFileSync('components/ProjectTutor.tsx', 'utf8');
    const logAt = source.indexOf('className="tutor-log"');
    const emptyAt = source.indexOf('className="tutor-empty"');
    expect(logAt).toBeGreaterThan(-1);
    expect(emptyAt).toBeGreaterThan(logAt);
  });
});
