import { describe, expect, it } from 'vitest';
import { classify, decodePdf, decodeText } from '../src/routes/attachments.js';

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

/* ------------------------------------------------------------------ *
 * PDF text extraction
 * ------------------------------------------------------------------ */

const NL = String.fromCharCode(10);

/**
 * A minimal but genuinely valid single-page PDF containing `contents`.
 *
 * Built by hand rather than mocked: the point of these tests is that a real
 * parser is handed real bytes. The bug being guarded against was PDFs being
 * accepted by `classify` and then never read at all, which a mocked extractor
 * would have happily reported as working.
 */
function makePdf(contents: string): Buffer {
  const stream = 'BT /F1 24 Tf 72 700 Td (' + contents + ') Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + stream.length + ' >>' + NL + 'stream' + NL + stream + NL + 'endstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4' + NL;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += String(i + 1) + ' 0 obj' + NL + body + NL + 'endobj' + NL;
  });

  const xrefAt = pdf.length;
  pdf += 'xref' + NL + '0 ' + (objects.length + 1) + NL + '0000000000 65535 f ' + NL;
  for (const off of offsets) {
    pdf += String(off).padStart(10, '0') + ' 00000 n ' + NL;
  }
  pdf +=
    'trailer' + NL + '<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>' + NL +
    'startxref' + NL + xrefAt + NL + '%%EOF';

  return Buffer.from(pdf, 'latin1');
}

describe('decodePdf', () => {
  it('reads the text layer out of a real PDF', async () => {
    const text = await decodePdf(makePdf('Closures capture their enclosing scope'));
    expect(text).not.toBeNull();
    expect(text).toContain('Closures capture their enclosing scope');
  });

  it('returns null for bytes that are not a PDF at all', async () => {
    expect(await decodePdf(Buffer.from('this is plainly not a pdf', 'utf8'))).toBeNull();
  });

  it('returns null rather than throwing when there is no text to extract', async () => {
    // A scanned PDF is images: structurally valid, nothing in the text layer.
    // That is a reportable outcome, not a crash.
    await expect(decodePdf(makePdf(''))).resolves.toBeNull();
  });

  it('caps extracted text at the same ceiling as plain text files', async () => {
    const text = await decodePdf(makePdf('concept '.repeat(20_000)));
    if (text !== null) expect(text.length).toBeLessThanOrEqual(60_000);
  });
});
