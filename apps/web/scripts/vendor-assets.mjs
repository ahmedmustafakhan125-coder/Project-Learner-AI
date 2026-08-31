/**
 * Copy Monaco and the Pyodide runtime into public/ so they are served from our
 * own origin.
 *
 * Both default to loading from a CDN, and both are blocked by the app CSP,
 * which does not list one. Widening script-src to a third-party CDN to fix that
 * would weaken the policy for every page; serving the files ourselves keeps the
 * policy tight and removes a runtime dependency on someone else's uptime.
 *
 * The output is gitignored and rebuilt from node_modules, so the versions can
 * never drift from package.json.
 */
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '..', 'public');

/** Only the files Pyodide needs at runtime — the package also ships types and maps. */
const PYODIDE_FILES = [
  'pyodide.js',
  'pyodide.asm.js',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
];

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function vendorMonaco() {
  const vs = join(dirname(require.resolve('monaco-editor/package.json')), 'min', 'vs');
  const dest = join(publicDir, 'monaco', 'vs');
  await rm(dest, { recursive: true, force: true });
  await mkdir(dirname(dest), { recursive: true });
  await cp(vs, dest, { recursive: true });
  console.log('vendored monaco  ->', dest);
}

async function vendorPyodide() {
  const src = dirname(require.resolve('pyodide/package.json'));
  const dest = join(publicDir, 'pyodide');
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  for (const file of PYODIDE_FILES) {
    const from = join(src, file);
    if (!(await exists(from))) {
      throw new Error(`pyodide is missing ${file} — expected it in ${src}`);
    }
    await cp(from, join(dest, file));
  }
  console.log('vendored pyodide ->', dest);
}

await vendorMonaco();
await vendorPyodide();
