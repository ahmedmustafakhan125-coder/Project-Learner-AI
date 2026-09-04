/**
 * A minimal ZIP writer.
 *
 * Hand-rolled rather than pulled in, because the whole requirement is "put
 * these text files in one downloadable archive" and every library that does it
 * also does compression, streaming, encryption and ZIP64. The STORE method —
 * no compression — is a header, the bytes, and a directory at the end. A source
 * project is a few hundred kilobytes of text; the bandwidth saved by deflating
 * it does not pay for a dependency in the download path.
 *
 * Written to the 1989 APPNOTE common subset that every unzip implementation
 * supports: local file headers, no data descriptors, no ZIP64, UTF-8 names
 * flagged so paths survive.
 */

/** Bit 11 of the general-purpose flags: the filename is UTF-8, not CP437. */
const UTF8_FLAG = 0x0800;

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const END_OF_DIRECTORY_SIG = 0x06054b50;

/** ZIP predates ZIP64 by a decade; beyond this the format needs the extension. */
const MAX_ENTRIES = 0xffff;

export interface ZipEntry {
  path: string;
  contents: string;
}

/* ------------------------------------------------------------------ *
 * CRC-32
 * ------------------------------------------------------------------ */

/** The standard IEEE 802.3 polynomial, reversed — what ZIP checksums with. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ *
 * DOS date/time
 * ------------------------------------------------------------------ */

/**
 * ZIP stores mtime as a packed 1980-epoch DOS timestamp.
 *
 * Fixed, not `Date.now()`: the same project must produce byte-identical
 * archives, so a re-download can be compared and a test can assert on bytes.
 */
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (1 << 9) | (1 << 5) | 1; // 1981-01-01, the earliest safe value

/* ------------------------------------------------------------------ *
 * Building
 * ------------------------------------------------------------------ */

function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/**
 * Reject the two things a path in an archive must never do: escape the
 * extraction directory, or be absolute. Both are how a zip overwrites files
 * outside where the user unpacked it, and the paths here come from model
 * output.
 */
export function safeArchivePath(path: string): string | null {
  const normalised = path.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '');
  if (!normalised || normalised.startsWith('/') || /^[a-zA-Z]:/.test(normalised)) return null;
  if (normalised.split('/').some((segment) => segment === '..')) return null;
  return normalised;
}

/**
 * Build a ZIP archive from text files.
 *
 * Duplicate and unsafe paths are dropped rather than written: an archive with
 * two entries at one path extracts unpredictably, and the caller has no way to
 * see which one won.
 */
export function createZip(entries: ZipEntry[]): Buffer {
  const encoder = new TextEncoder();
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let count = 0;

  for (const entry of entries) {
    if (count >= MAX_ENTRIES) break;

    const path = safeArchivePath(entry.path);
    if (!path || seen.has(path)) continue;
    seen.add(path);

    const nameBytes = encoder.encode(path);
    const dataBytes = encoder.encode(entry.contents);
    const crc = crc32(dataBytes);

    const localHeader = Buffer.from([
      ...u32(LOCAL_HEADER_SIG),
      ...u16(20), // version needed: 2.0
      ...u16(UTF8_FLAG),
      ...u16(0), // method: STORE
      ...u16(DOS_TIME),
      ...u16(DOS_DATE),
      ...u32(crc),
      ...u32(dataBytes.length), // compressed == uncompressed under STORE
      ...u32(dataBytes.length),
      ...u16(nameBytes.length),
      ...u16(0), // no extra field
    ]);

    local.push(localHeader, Buffer.from(nameBytes), Buffer.from(dataBytes));

    central.push(
      Buffer.from([
        ...u32(CENTRAL_HEADER_SIG),
        ...u16(20), // version made by
        ...u16(20), // version needed
        ...u16(UTF8_FLAG),
        ...u16(0),
        ...u16(DOS_TIME),
        ...u16(DOS_DATE),
        ...u32(crc),
        ...u32(dataBytes.length),
        ...u32(dataBytes.length),
        ...u16(nameBytes.length),
        ...u16(0), // extra
        ...u16(0), // comment
        ...u16(0), // disk number
        ...u16(0), // internal attributes
        ...u32(0o100644 << 16), // external attributes: regular file, rw-r--r--
        ...u32(offset),
      ]),
      Buffer.from(nameBytes),
    );

    offset += localHeader.length + nameBytes.length + dataBytes.length;
    count += 1;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.from([
    ...u32(END_OF_DIRECTORY_SIG),
    ...u16(0), // this disk
    ...u16(0), // disk with the directory
    ...u16(count),
    ...u16(count),
    ...u32(centralBuffer.length),
    ...u32(offset),
    ...u16(0), // no archive comment
  ]);

  return Buffer.concat([...local, centralBuffer, end]);
}

/**
 * A filesystem- and header-safe name for the download.
 *
 * The project title is learner-supplied text that reaches a Content-Disposition
 * header, so it is reduced to a conservative slug rather than escaped.
 */
export function archiveName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'project'}.zip`;
}
