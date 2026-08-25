import { describe, expect, it } from 'vitest';
import { classify, decodeText } from '../src/routes/attachments.js';

/**
 * These guard an upload path that accepts attacker-controlled bytes.
 *
 * The first test exists because an earlier version compared against an empty
 * string by accident — `''.indexOf('')` returns 0, so the binary check fired on
 * every input and silently rejected every text file a learner attached.
 */

describe('decodeText', () => {
  it('accepts ordinary source code — including spaces', () => {
    const source = 'function add(a, b) {\n  return a + b;\n}\n';
    expect(decodeText(Buffer.from(source, 'utf8'))).toBe(source);
  });

  it('accepts text containing non-ASCII characters', () => {
    const source = '// naïve café — 日本語 — ok\nconst x = 1;\n';
    expect(decodeText(Buffer.from(source, 'utf8'))).toBe(source);
  });

  it('accepts an empty file', () => {
    expect(decodeText(Buffer.from('', 'utf8'))).toBe('');
  });

  it('rejects binary content containing a NUL byte', () => {
    // A PNG renamed to .js passes the extension check, so the bytes decide.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    expect(decodeText(png)).toBeNull();
  });

  it('rejects bytes that are not valid UTF-8', () => {
    const garbage = Buffer.from(Array.from({ length: 400 }, (_, i) => 0x80 + (i % 60)));
    expect(decodeText(garbage)).toBeNull();
  });

  it('tolerates a single stray replacement character in a long file', () => {
    // One bad byte in a large legitimate file should not disqualify it.
    const text = 'const x = 1;\n'.repeat(500) + String.fromCharCode(0xfffd);
    expect(decodeText(Buffer.from(text, 'utf8'))).not.toBeNull();
  });

  it('truncates very large files rather than sending everything to a model', () => {
    const huge = 'x'.repeat(200_000);
    const decoded = decodeText(Buffer.from(huge, 'utf8'))!;
    expect(decoded.length).toBeLessThan(huge.length);
    expect(decoded.length).toBeGreaterThan(1000);
  });
});

describe('classify', () => {
  it('recognises source files by extension when the MIME type is generic', () => {
    // Browsers frequently send application/octet-stream for .py, .rs, .go
    expect(classify('main.py', 'application/octet-stream')).toBe('text');
    expect(classify('lib.rs', 'application/octet-stream')).toBe('text');
    expect(classify('Component.tsx', '')).toBe('text');
  });

  it('recognises text by MIME type when the extension is unhelpful', () => {
    expect(classify('notes', 'text/plain')).toBe('text');
  });

  it('recognises images and PDFs', () => {
    expect(classify('screenshot.png', 'image/png')).toBe('image');
    expect(classify('spec.pdf', 'application/pdf')).toBe('pdf');
  });

  it('refuses anything not on the allowlist', () => {
    // An allowlist, not a blocklist — unknown types are refused by default.
    expect(classify('installer.exe', 'application/x-msdownload')).toBeNull();
    expect(classify('archive.zip', 'application/zip')).toBeNull();
    expect(classify('movie.mp4', 'video/mp4')).toBeNull();
  });

  it('is case-insensitive about extensions', () => {
    expect(classify('MAIN.PY', 'application/octet-stream')).toBe('text');
  });

  it('refuses a file with no extension and an unknown type', () => {
    expect(classify('mystery', 'application/octet-stream')).toBeNull();
  });
});
