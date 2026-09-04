/**
 * P3 exit criterion — sandbox containment, proven by execution.
 *
 * CONTEXT.md requires three specific escape attempts to be *provably* contained:
 * reaching `window.parent`, calling `fetch`, and an infinite loop. Proving that
 * needs a browser. The static checks in `sandbox-escape.test.ts` assert the
 * configuration is spelled correctly; these assert the browser actually stops
 * the escape, which is a different claim.
 *
 * The last test is a mutation check: it rebuilds the same frame WITH
 * `allow-same-origin` and asserts the escape then SUCCEEDS. Without it there is
 * no evidence these tests can fail, and a containment test that cannot fail is
 * decorative.
 *
 * Runs against the real production server so the real CSP headers apply.
 * Requires a built app (`npm run build`) and an installed Chrome or Edge.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on('error', rej);
    srv.listen(0, () => {
      const addr = srv.address() as { port: number };
      srv.close(() => res(addr.port));
    });
  });
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Server did not start within ' + timeoutMs + 'ms');
}

let server: ChildProcess | undefined;
let browser: Browser | undefined;
let origin = '';

beforeAll(async () => {
  if (!existsSync(resolve(webRoot, '.next'))) {
    throw new Error('No .next build found. Run `npm run build` before the containment tests.');
  }
  const port = await freePort();
  origin = 'http://localhost:' + port;
  server = spawn('npx', ['next', 'start', '-p', String(port)], {
    cwd: webRoot,
    shell: true,
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  await waitForServer(origin, 90_000);
  browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
}, 150_000);

/** Never let cleanup wedge the run: bound every teardown step. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | void> {
  return Promise.race([work, new Promise<void>((r) => setTimeout(r, ms))]);
}

afterAll(async () => {
  await withTimeout(browser?.close() ?? Promise.resolve(), 10_000);

  // `shell: true` puts a cmd.exe/sh between us and the server, so killing the
  // direct child leaves the actual Next process holding the port. Take the
  // whole tree down, and do not block the suite if that itself stalls.
  const pid = server?.pid;
  if (pid) {
    if (process.platform === 'win32') {
      await withTimeout(
        new Promise<void>((done) => {
          const t = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            shell: false,
          });
          t.on('close', () => done());
          t.on('error', () => done());
        }),
        10_000,
      );
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        server?.kill('SIGKILL');
      }
    }
  }
}, 40_000);

/**
 * Mount a sandbox frame exactly as SandboxFrame does, feed it `code` the way a
 * learner's submission arrives, and return whatever the code reported back.
 *
 * `extraSandbox` exists only for the mutation check.
 */
async function runInSandbox(code: string, extraSandbox = ''): Promise<Record<string, string>> {
  const page = await (await browser!.newContext()).newPage();
  await page.goto(origin, { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(
    ({ code, extraSandbox }) =>
      new Promise<Record<string, string>>((resolve) => {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', ('allow-scripts ' + extraSandbox).trim());
        frame.src = '/sandbox?runtime=web';
        frame.style.cssText =
          'width:0;height:0;border:none;position:absolute;visibility:hidden';

        const done = (payload: Record<string, string>) => {
          window.removeEventListener('message', onMessage);
          frame.remove();
          resolve(payload);
        };

        const onMessage = (ev: MessageEvent) => {
          if (ev.source !== frame.contentWindow) return;
          const data = ev.data as { __probe?: boolean; payload?: Record<string, string> };
          if (data && data.__probe && data.payload) done(data.payload);
        };
        window.addEventListener('message', onMessage);

        frame.addEventListener('load', () => {
          frame.contentWindow!.postMessage(
            { type: 'exec-web', files: [{ path: 'escape.js', contents: code }], tests: [] },
            '*',
          );
        });
        document.body.appendChild(frame);

        setTimeout(() => done({ timedOut: 'true' }), 15_000);
      }),
    { code, extraSandbox },
  );

  await page.close();
  return result;
}

const REACH_PARENT = `
  var out;
  try { out = 'ESCAPED:' + String(parent.document.title); }
  catch (e) { out = 'BLOCKED:' + e.name; }
  parent.postMessage({ __probe: true, payload: { parentDom: out } }, '*');
`;

describe('P3 exit criterion: sandbox containment', () => {
  it('escape 1 — learner code cannot reach window.parent', async () => {
    const result = await runInSandbox(REACH_PARENT);
    // Guard the guard: if the sandbox never answers, `parentDom` is undefined and
    // a bare toMatch reports a type error rather than "containment unverified".
    expect(result.timedOut, 'sandbox never replied — the probe timed out').toBeUndefined();
    expect(result.parentDom).toMatch(/^BLOCKED:/);
    expect(result.parentDom).not.toContain('ESCAPED');
  }, 60_000);

  it('escape 2 — learner code cannot fetch an external origin', async () => {
    const result = await runInSandbox(`
      fetch('https://example.com/')
        .then(function () {
          parent.postMessage({ __probe: true, payload: { fetchExternal: 'ESCAPED' } }, '*');
        })
        .catch(function (e) {
          parent.postMessage({ __probe: true, payload: { fetchExternal: 'BLOCKED:' + e.name } }, '*');
        });
    `);
    expect(result.fetchExternal).toMatch(/^BLOCKED:/);
  }, 60_000);

  it('escape 3 — an infinite loop cannot freeze the parent, and the frame can be killed', async () => {
    const page = await (await browser!.newContext()).newPage();
    await page.goto(origin, { waitUntil: 'domcontentloaded' });

    const outcome = await page.evaluate(async () => {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.src = '/sandbox?runtime=web';
      document.body.appendChild(frame);
      await new Promise((r) => frame.addEventListener('load', r, { once: true }));

      frame.contentWindow!.postMessage(
        {
          type: 'exec-web',
          files: [{ path: 'loop.js', contents: 'while (true) {}' }],
          tests: [],
        },
        '*',
      );

      // The parent must stay responsive while the frame is wedged. If the loop
      // blocked the whole page this timer would never fire and the test would
      // time out rather than return.
      const before = Date.now();
      await new Promise((r) => setTimeout(r, 1500));
      const parentAlive = Date.now() - before >= 1400;

      frame.remove();
      return { parentAlive, frameRemoved: !document.body.contains(frame) };
    });

    await page.close();
    expect(outcome.parentAlive).toBe(true);
    expect(outcome.frameRemoved).toBe(true);
  }, 60_000);

  it('mutation check — the same escape SUCCEEDS with allow-same-origin, proving these tests bite', async () => {
    const result = await runInSandbox(REACH_PARENT, 'allow-same-origin');
    expect(result.parentDom).toMatch(/^ESCAPED:/);
  }, 60_000);
});
