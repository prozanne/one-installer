import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { posix as path } from 'node:path';
import type { IFs } from 'memfs';
import * as nodeFs from 'node:fs';

const RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

export interface ExtractInput {
  zipBytes: Buffer;
  destDir: string;
  fs?: IFs | typeof nodeFs;
  /**
   * Maximum total uncompressed bytes to extract before aborting. Defends
   * against zip-bomb payloads (compressed kilobytes → uncompressed gigabytes)
   * that would OOM the main process or fill the user's disk before any
   * downstream policy gets a chance to refuse.
   *
   * Default 4 GiB — generous enough for any legitimate VDX app (largest
   * we've seen is ~600 MiB) but a hard ceiling that catches obvious abuse.
   * Callers can tighten further (vdxpkg outer extract uses a smaller cap).
   */
  maxTotalBytes?: number;
}

export interface ExtractResult {
  files: string[];
  totalBytes: number;
}

const DEFAULT_MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;

export function checkEntryName(name: string): void {
  // ZIP APPNOTE.TXT §4.4.17.1 mandates forward-slash separators. Backslashes in entry
  // names are non-conformant and would be interpreted as path separators on Windows
  // while the POSIX zip-slip checks below would treat them as literal characters,
  // creating a cross-platform traversal hole. Reject outright.
  if (name.includes('\\')) {
    throw new Error(`Refusing entry with backslash separator: ${name}`);
  }
  // NUL and other control bytes have no business in zip entry names. The
  // control-character regex *is* the point of this check, so the lint rule
  // that flags raw control chars in regexes is intentionally suppressed.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) {
    throw new Error(`Refusing entry with control characters: ${name}`);
  }
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new Error(`Refusing entry with absolute path: ${name}`);
  }
  const norm = path.normalize(name);
  if (norm.startsWith('..') || norm.includes('/../') || norm === '..') {
    throw new Error(`Refusing entry due to zip slip: ${name}`);
  }
  for (const part of norm.split('/')) {
    const base = part.split('.')[0]?.toUpperCase();
    if (base && RESERVED.has(base)) throw new Error(`Refusing reserved Windows name: ${name}`);
    if (/[\s.]$/.test(part)) throw new Error(`Refusing trailing space/dot in name: ${name}`);
  }
}

function openZip(buf: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('open zip failed'));
      resolve(zip);
    });
  });
}

export async function listZipEntries(buf: Buffer): Promise<string[]> {
  const zip = await openZip(buf);
  const out: string[] = [];
  try {
    return await new Promise<string[]>((resolve, reject) => {
      zip.on('entry', (e: Entry) => {
        out.push(e.fileName);
        zip.readEntry();
      });
      zip.on('end', () => resolve(out));
      zip.on('error', reject);
      zip.readEntry();
    });
  } finally {
    // yauzl holds an FD on the underlying source until close. Even
    // fromBuffer mode allocates inflate streams + listeners — release them
    // on the rejection path too, not just success.
    try {
      zip.close();
    } catch {
      /* already closed by `end` */
    }
  }
}

export async function extractZipSafe(input: ExtractInput): Promise<ExtractResult> {
  const fs = (input.fs ?? nodeFs) as IFs;
  const maxTotal = input.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const zip = await openZip(input.zipBytes);
  const out: string[] = [];
  let totalBytes = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('entry', (e: Entry) => {
        try {
          // Defend against zip-bomb manifests: enforce the cap on the declared
          // uncompressedSize *before* we begin streaming an entry, so a single
          // multi-TB entry doesn't fill the disk before we notice.
          if (totalBytes + e.uncompressedSize > maxTotal) {
            throw new Error(
              `Refusing zip: total uncompressed bytes would exceed cap (${maxTotal} bytes)`,
            );
          }
          // Detect symlinks via external file attributes (POSIX file type 0xA000).
          const externalAttr = (e.externalFileAttributes ?? 0) >>> 16;
          const fileType = externalAttr & 0xf000;
          if (fileType === 0xa000) {
            throw new Error(`Refusing symlink entry: ${e.fileName}`);
          }
          if (/\/$/.test(e.fileName)) {
            fs.promises
              .mkdir(path.join(input.destDir, e.fileName), { recursive: true })
              .then(() => zip.readEntry())
              .catch(reject);
            return;
          }
          checkEntryName(e.fileName);
          const dest = path.join(input.destDir, e.fileName);
          zip.openReadStream(e, (err, rs) => {
            if (err || !rs) return reject(err);
            fs.promises
              .mkdir(path.dirname(dest), { recursive: true })
              .then(() => {
                const ws = (fs as IFs).createWriteStream(dest);
                rs.pipe(ws);
                ws.on('finish', () => {
                  out.push(e.fileName);
                  totalBytes += e.uncompressedSize;
                  zip.readEntry();
                });
                ws.on('error', (e2) => {
                  rs.destroy();
                  reject(e2);
                });
              })
              .catch((e2) => {
                rs.destroy();
                reject(e2);
              });
          });
        } catch (err) {
          reject(err);
        }
      });
      zip.on('end', () => resolve());
      zip.on('error', reject);
      zip.readEntry();
    });
  } finally {
    // Always release the yauzl handle, on success and on error. yauzl
    // holds inflate streams + listeners + (in fd mode) an OS file handle
    // until close().
    try {
      zip.close();
    } catch {
      /* already closed */
    }
  }

  return { files: out, totalBytes };
}
