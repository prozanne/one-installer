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
}

export interface ExtractResult {
  files: string[];
  totalBytes: number;
}

export function checkEntryName(name: string): void {
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
  return new Promise((resolve, reject) => {
    zip.on('entry', (e: Entry) => {
      out.push(e.fileName);
      zip.readEntry();
    });
    zip.on('end', () => resolve(out));
    zip.on('error', reject);
    zip.readEntry();
  });
}

export async function extractZipSafe(input: ExtractInput): Promise<ExtractResult> {
  const fs = (input.fs ?? nodeFs) as IFs;
  const zip = await openZip(input.zipBytes);
  const out: string[] = [];
  let totalBytes = 0;

  await new Promise<void>((resolve, reject) => {
    zip.on('entry', (e: Entry) => {
      try {
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
              ws.on('error', reject);
            })
            .catch(reject);
        });
      } catch (err) {
        reject(err);
      }
    });
    zip.on('end', () => resolve());
    zip.on('error', reject);
    zip.readEntry();
  });

  return { files: out, totalBytes };
}
