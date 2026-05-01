import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogSchema, type CatalogT } from '@shared/schema';
import type { CatalogKindT } from '@shared/ipc-types';

export interface CatalogCacheRecord {
  catalog: CatalogT;
  /** True when the last successful fetch verified the catalog signature. Optional for forward compat. */
  signatureValid?: boolean;
  fetchedAt: string;
  sourceUrl?: string;
  /** Server ETag — sent as If-None-Match on the next refresh for 304 short-circuit. */
  etag?: string | null;
}

/**
 * Disk-backed cache so the second time the user opens the Agents tab the
 * list paints instantly — no network round-trip blocks the UI. The cached
 * record is then refreshed in the background; the fetcher's 304 path keeps
 * the refresh cost to a single conditional GET when nothing changed.
 *
 * Files live under `<userData>/cache/catalog/<kind>.json`. Corrupt or
 * schema-invalid files are silently dropped — the cache is always
 * reconstructible from the network.
 */
export class CatalogCache {
  private readonly dir: string;

  constructor(baseCacheDir: string) {
    this.dir = join(baseCacheDir, 'catalog');
    mkdirSync(this.dir, { recursive: true });
  }

  private fileFor(kind: CatalogKindT): string {
    return join(this.dir, `${kind}.json`);
  }

  read(kind: CatalogKindT): CatalogCacheRecord | null {
    const file = this.fileFor(kind);
    if (!existsSync(file)) return null;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
      // Validate the embedded catalog (cache file may have been written by an older
      // host before we evolved the schema; in that case discard it rather than
      // surface a typed but stale shape).
      const catalog = CatalogSchema.parse(raw['catalog']);
      // Critical: ignore the on-disk `signatureValid` flag. We don't store the
      // signature bytes alongside the catalog so we can't re-verify from cache;
      // a local attacker who flips this flag on disk would otherwise have the
      // tampered catalog treated as signature-validated forever after. Force
      // the cached read to "unverified" — the next online refresh will perform
      // a real signature check and update the flag for the next cold start.
      const fetchedAt = String(raw['fetchedAt'] ?? '');
      const sourceUrl = String(raw['sourceUrl'] ?? '');
      const etag = raw['etag'] === null ? null : typeof raw['etag'] === 'string' ? raw['etag'] : null;
      if (!fetchedAt || !sourceUrl) return null;
      return { catalog, signatureValid: false, fetchedAt, sourceUrl, etag };
    } catch {
      // Drop corrupt cache silently — never block startup on a bad cache file.
      try {
        unlinkSync(file);
      } catch {
        /* ignore */
      }
      return null;
    }
  }

  write(kind: CatalogKindT, record: CatalogCacheRecord): void {
    // Write via tmp+rename so a crash mid-write doesn't leave a torn file
    // that would silently be dropped on next read. mode 0o600 so a multi-user
    // POSIX host can't have another local account replace the cache.
    const file = this.fileFor(kind);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    try {
      // node's renameSync is atomic on the same volume.
      renameSync(tmp, file);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw e;
    }
  }
}
