import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { archiveName, crc32, createZip, safeArchivePath } from '../src/zip.js';

/**
 * The archive is hand-rolled, so these tests check it against the format rather
 * than against itself: the CRC-32 values are the published reference vectors,
 * and the finished archive is opened by an unzip implementation that is not
 * ours (Node has none built in, so this uses PowerShell's Expand-Archive, which
 * is the .NET ZipFile reader).
 */

const decoder = new TextDecoder();

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('crc32', () => {
  it('matches the published reference vectors', () => {
    expect(crc32(bytes(''))).toBe(0x00000000);
    expect(crc32(bytes('a'))).toBe(0xe8b7be43);
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926);
    expect(crc32(bytes('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });
});

describe('safeArchivePath', () => {
  it('refuses paths that escape the extraction directory', () => {
    // These are the two ways an archive overwrites files outside where it was
    // unpacked, and every path here came out of a language model.
    expect(safeArchivePath('../../.bashrc')).toBeNull();
    expect(safeArchivePath('src/../../etc/passwd')).toBeNull();
    expect(safeArchivePath('/etc/passwd')).toBeNull();
    expect(safeArchivePath('C:/Windows/System32/x.dll')).toBeNull();
    expect(safeArchivePath('   ')).toBeNull();
  });

  it('keeps ordinary project paths, normalised', () => {
    expect(safeArchivePath('src/app.py')).toBe('src/app.py');
    expect(safeArchivePath('./src//app.py')).toBe('src/app.py');
    expect(safeArchivePath('src\\app.py')).toBe('src/app.py');
    // "..name" is a filename, not a traversal.
    expect(safeArchivePath('src/..hidden.py')).toBe('src/..hidden.py');
  });
});

describe('createZip', () => {
  it('writes a local header, a central directory and an end record', () => {
    const zip = createZip([{ path: 'a.txt', contents: 'hello' }]);

    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.subarray(zip.length - 22).readUInt32LE(0)).toBe(0x06054b50);
    // One entry, counted in both fields of the end record.
    expect(zip.readUInt16LE(zip.length - 22 + 8)).toBe(1);
    expect(zip.readUInt16LE(zip.length - 22 + 10)).toBe(1);
  });

  it('is byte-identical for the same input', () => {
    const files = [
      { path: 'a.txt', contents: 'one' },
      { path: 'b/c.txt', contents: 'two' },
    ];
    expect(createZip(files).equals(createZip(files))).toBe(true);
  });

  it('drops duplicate and unsafe paths rather than writing them', () => {
    const zip = createZip([
      { path: 'a.txt', contents: 'first' },
      { path: './a.txt', contents: 'second' },
      { path: '../escape.txt', contents: 'no' },
    ]);

    expect(zip.readUInt16LE(zip.length - 22 + 8)).toBe(1);
    expect(decoder.decode(zip)).toContain('first');
    expect(decoder.decode(zip)).not.toContain('second');
  });

  it('produces a valid empty archive', () => {
    const zip = createZip([]);
    expect(zip.length).toBe(22);
    expect(zip.readUInt32LE(0)).toBe(0x06054b50);
  });

  it('round-trips through a real unzip implementation', () => {
    const zip = createZip([
      { path: 'README.md', contents: '# Title\n\nBody text.\n' },
      { path: 'src/app.py', contents: 'def main():\n    print("hi")\n' },
      { path: 'src/nested/deep.txt', contents: 'unicode: café — ok\n' },
    ]);

    const dir = mkdtempSync(join(tmpdir(), 'zip-test-'));
    try {
      const archive = join(dir, 'out.zip');
      writeFileSync(archive, zip);

      // .NET's ZipFile via PowerShell — an implementation we did not write.
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${join(dir, 'out')}' -Force`,
        ],
        { stdio: 'pipe' },
      );

      expect(readFileSync(join(dir, 'out', 'README.md'), 'utf8')).toBe('# Title\n\nBody text.\n');
      expect(readFileSync(join(dir, 'out', 'src', 'app.py'), 'utf8')).toBe(
        'def main():\n    print("hi")\n',
      );
      expect(readFileSync(join(dir, 'out', 'src', 'nested', 'deep.txt'), 'utf8')).toBe(
        'unicode: café — ok\n',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('archiveName', () => {
  it('reduces a learner-supplied title to a safe filename', () => {
    expect(archiveName('CLI Todo with persistence')).toBe('cli-todo-with-persistence.zip');
    // The title reaches a Content-Disposition header, so quotes, newlines and
    // path separators must not survive it.
    expect(archiveName('a"b\nc/../d')).toBe('a-b-c-d.zip');
    expect(archiveName('///')).toBe('project.zip');
    expect(archiveName('')).toBe('project.zip');
  });
});
