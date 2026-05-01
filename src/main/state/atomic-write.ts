import type { IFs } from 'memfs';
import * as nodeFs from 'node:fs';

type FsLike = IFs | typeof nodeFs;

export interface AtomicWriteOptions {
  /**
   * Fired when `rename` failed with EXDEV (cross-device link) and the writer
   * fell back to a non-atomic copy+delete. The host should surface this at
   * `warn` level since the atomicity guarantee is degraded for that write.
   * Recovery on mid-fallback crash relies on `.bak` (see readJsonWithBakFallback).
   */
  onCrossVolumeFallback?: (info: { path: string; code: string }) => void;
}

export async function atomicWriteJson(
  path: string,
  data: unknown,
  fs: FsLike = nodeFs,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const tmp = `${path}.tmp`;
  const bak = `${path}.bak`;
  const json = JSON.stringify(data, null, 2);
  const fsP = (fs as IFs).promises;
  await fsP.writeFile(tmp, json);
  try {
    await fsP.copyFile(path, bak);
  } catch {
    // no existing — ignore
  }
  try {
    await fsP.rename(tmp, path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw e;
    // Cross-volume rename refused by the OS (e.g. %APPDATA% redirected to a
    // network share whose mount point differs from the tmp directory's volume).
    // Fall back to a plain in-place write of the new bytes; this is NOT atomic,
    // but `.bak` from the copyFile above preserves the prior good state.
    await fsP.writeFile(path, json);
    try {
      await fsP.unlink(tmp);
    } catch {
      /* tmp may already be gone */
    }
    opts.onCrossVolumeFallback?.({ path, code });
  }
}

export async function readJsonOrDefault<T>(
  path: string,
  defaultValue: () => T,
  fs: FsLike = nodeFs,
): Promise<T> {
  try {
    const buf = await (fs as IFs).promises.readFile(path);
    return JSON.parse(buf.toString()) as T;
  } catch {
    return defaultValue();
  }
}

export type ReadStatus = 'primary' | 'bak' | 'default';

/**
 * Read JSON with `.bak` fallback. Distinguishes three outcomes:
 * 1. Primary file parses cleanly → return primary.
 * 2. Primary missing → return default (no .bak attempt; nothing to recover).
 * 3. Primary present but unparseable → try `.bak`; if that parses, return it; else default.
 *
 * The third path is the data-loss guard: a torn write on `installed.json` would
 * silently erase the install registry without this fallback.
 */
export async function readJsonWithBakFallback<T>(
  primaryPath: string,
  bakPath: string,
  defaultValue: () => T,
  fs: FsLike = nodeFs,
): Promise<{ value: T; status: ReadStatus }> {
  const fsP = (fs as IFs).promises;
  let primaryBuf: Buffer | undefined;
  try {
    primaryBuf = (await fsP.readFile(primaryPath)) as Buffer;
  } catch {
    return { value: defaultValue(), status: 'default' };
  }
  try {
    return { value: JSON.parse(primaryBuf.toString()) as T, status: 'primary' };
  } catch {
    // Primary unparseable — try .bak before giving up.
  }
  try {
    const bakBuf = (await fsP.readFile(bakPath)) as Buffer;
    return { value: JSON.parse(bakBuf.toString()) as T, status: 'bak' };
  } catch {
    return { value: defaultValue(), status: 'default' };
  }
}
