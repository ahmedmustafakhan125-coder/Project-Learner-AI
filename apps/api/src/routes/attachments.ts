import type { FastifyInstance } from 'fastify';

import { requireAuth, userOf } from '../auth.js';
import { db } from '../db.js';

/**
 * File attachments.
 *
 * Uploaded content is attacker-controlled — a learner can put anything in a
 * file, including text engineered to read as instructions to the model. Three
 * things follow from that, and all three are enforced here rather than trusted
 * to the prompt:
 *
 *   1. An allowlist of types, not a blocklist. Anything unrecognised is refused.
 *   2. Hard size and count caps, checked against actual bytes read, not the
 *      declared Content-Length.
 *   3. Extracted text is never concatenated into a prompt here. It is returned
 *      as data, and the fan-out wraps it in <attachment> delimiters that
 *      PEDAGOGY_CORE instructs the model to treat as material, never commands.
 */

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_EXTRACTED_CHARS = 60_000;
const STORAGE_BUCKET = 'attachments';

/**
 * Types we will read as text. Deliberately narrow: these are the things a
 * programming learner actually attaches.
 */
const TEXT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'text/css',
  'text/xml',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-httpd-php',
  'application/x-sh',
  'application/sql',
]);

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'json', 'yaml', 'yml', 'toml', 'ini', 'env',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt',
  'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'swift', 'scala', 'sh', 'bash', 'zsh',
  'sql', 'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte', 'xml', 'gradle',
  'dockerfile', 'makefile', 'log', 'diff', 'patch',
]);

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function extensionOf(filename: string): string {
  const parts = filename.toLowerCase().split('.');
  return parts.length > 1 ? (parts.pop() ?? '') : '';
}

export function classify(filename: string, mimeType: string): 'text' | 'image' | 'pdf' | null {
  if (TEXT_TYPES.has(mimeType) || mimeType.startsWith('text/')) return 'text';
  if (TEXT_EXTENSIONS.has(extensionOf(filename))) return 'text';
  if (IMAGE_TYPES.has(mimeType)) return 'image';
  if (mimeType === 'application/pdf') return 'pdf';
  return null;
}

/**
 * Decode as UTF-8, rejecting anything that turns out to be binary.
 *
 * A `.png` renamed to `.js` passes the extension check, so the bytes themselves
 * have to be inspected. Both guards below are written without string escapes on
 * purpose: an escaped NUL is easy to mangle in transit, and a silently empty
 * needle would make `indexOf` return 0 and reject every file as binary.
 */
export function decodeText(bytes: Buffer): string | null {
  // Byte 0 anywhere means binary, whatever the extension claimed.
  if (bytes.includes(0)) return null;

  const text = bytes.toString('utf8');

  // Many U+FFFD replacement characters mean the bytes were not valid UTF-8.
  const REPLACEMENT = String.fromCharCode(0xfffd);
  let replacements = 0;
  for (const char of text) {
    if (char === REPLACEMENT) replacements += 1;
  }
  if (replacements > 0 && replacements / Math.max(text.length, 1) > 0.01) return null;

  return text.slice(0, MAX_EXTRACTED_CHARS);
}

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/attachments', { preHandler: requireAuth }, async (request, reply) => {
    const user = userOf(request);

    const file = await request.file({ limits: { fileSize: MAX_BYTES, files: 1 } });
    if (!file) {
      return reply.code(400).send({ error: 'no_file', message: 'No file was uploaded.' });
    }

    const kind = classify(file.filename, file.mimetype);
    if (!kind) {
      return reply.code(415).send({
        error: 'unsupported_type',
        message:
          `Cannot read "${file.filename}". Attach source code, text, JSON, CSV, ` +
          `Markdown, an image, or a PDF.`,
      });
    }

    const bytes = await file.toBuffer();

    // `file.truncated` is set when the stream hit the limit — checking actual
    // bytes rather than a declared header is the point.
    if (file.file.truncated || bytes.byteLength > MAX_BYTES) {
      return reply.code(413).send({
        error: 'too_large',
        message: `Files must be under ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`,
      });
    }

    let extractedText: string | null = null;
    if (kind === 'text') {
      extractedText = decodeText(bytes);
      if (extractedText === null) {
        return reply.code(415).send({
          error: 'not_text',
          message: `"${file.filename}" looks like binary data, not text.`,
        });
      }
    }

    const storagePath = `${user.id}/${crypto.randomUUID()}/${sanitiseName(file.filename)}`;

    const { error: uploadError } = await db()
      .storage.from(STORAGE_BUCKET)
      .upload(storagePath, bytes, { contentType: file.mimetype, upsert: false });

    if (uploadError) {
      request.log.error({ err: uploadError }, 'attachment upload failed');
      return reply.code(500).send({ error: 'upload_failed', message: uploadError.message });
    }

    const { data, error } = await db()
      .from('attachments')
      .insert({
        user_id: user.id,
        storage_path: storagePath,
        filename: file.filename,
        mime_type: file.mimetype,
        size_bytes: bytes.byteLength,
        extracted_text: extractedText,
      })
      .select('id')
      .single();

    if (error) {
      return reply.code(500).send({ error: 'persist_failed', message: error.message });
    }

    // Shape matches AttachmentRef in @ai-edu/core.
    return reply.send({
      id: data.id,
      filename: file.filename,
      mimeType: file.mimetype,
      sizeBytes: bytes.byteLength,
      extractedText,
      providerFileId: null,
    });
  });
}

/** Keep the original name readable while making it safe as a storage key. */
function sanitiseName(filename: string): string {
  return filename.replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'file';
}
