/**
 * LocalFsSource — PackageSource implementation backed by the local filesystem.
 *
 * This is the ONLY source available in Phase 1.0, and is the canonical source
 * for all engine tests (backed by memfs).
 *
 * @see docs/superpowers/specs/2026-05-01-package-source-abstraction.md §3.3
 */
import * as nodeFsPromises from 'node:fs/promises';
import * as path from 'node:path';
import type {
  PackageSource,
  CatalogFetchResult,
  ManifestFetchResult,
  ByteRange,
} from '@shared/source/package-source';
import { throwSourceError } from '@shared/source/package-source';

// ---------------------------------------------------------------------------
// Validation helpers (T3)
// ---------------------------------------------------------------------------

const APP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ASSET_NAME_PATTERN = /^[A-Za-z0-9._-][A-Za-z0-9._/-]{0,255}$/;
const DOTDOT_PATTERN = /(?:^|[/\\])\.\.(?:[/\\]|$)/;

function validateAppId(appId: string): void {
  if (!APP_ID_PATTERN.test(appId)) {
    throwSourceError({
      kind: 'InvalidResponseError',
      message: 'Invalid appId format',
      retryable: false,
    });
  }
}

function validateVersion(version: string): void {
  if (!SEMVER_PATTERN.test(version)) {
    throwSourceError({
      kind: 'InvalidResponseError',
      message: 'Invalid version format',
      retryable: false,
    });
  }
}

function validateAssetName(assetName: string): void {
  if (
    !ASSET_NAME_PATTERN.test(assetName) ||
    DOTDOT_PATTERN.test(assetName) ||
    assetName.startsWith('/') ||
    assetName.startsWith('\\')
  ) {
    throwSourceError({
      kind: 'InvalidResponseError',
      message: 'Invalid asset name',
      retryable: false,
    });
  }
}

function assertInsideRoot(rootPath: string, resolved: string): void {
  const root = path.resolve(rootPath) + path.sep;
  if (!resolved.startsWith(root) && resolved !== path.resolve(rootPath)) {
    throwSourceError({
      kind: 'InvalidResponseError',
      message: 'Path escapes source root',
      retryable: false,
    });
  }
}

// ---------------------------------------------------------------------------
// Size caps (T5)
// ---------------------------------------------------------------------------

const CAP_CATALOG = 4 * 1024 * 1024;       // 4 MiB
const CAP_CATALOG_SIG = 256;
const CAP_MANIFEST = 1024 * 1024;           // 1 MiB
const CAP_MANIFEST_SIG = 256;
const CAP_VERSIONS = 256 * 1024;            // 256 KiB
const CAP_ASSET = 8 * 1024 * 1024;         // 8 MiB
const CAP_PAYLOAD_CHUNK = 1024 * 1024;      // 1 MiB per chunk

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface LocalFsConfig {
  /**
   * Root directory of the local mirror.
   *
   * Directory layout:
   *   ${rootPath}/catalog.json
   *   ${rootPath}/catalog.json.sig
   *   ${rootPath}/apps/${appId}/${version}/manifest.json
   *   ${rootPath}/apps/${appId}/${version}/manifest.json.sig
   *   ${rootPath}/apps/${appId}/${version}/payload.zip
   *   ${rootPath}/apps/${appId}/${version}/assets/${assetName}
   *
   * ETag is emulated via file mtime + size as a string: "${mtime}-${size}".
   */
  rootPath: string;

  /**
   * Optional: inject a custom `fs` implementation (defaults to node:fs/promises).
   * Injecting `memfs` makes this source fully in-memory — used in all engine tests.
   */
  fs?: typeof nodeFsPromises;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapFsError(e: unknown, resource: string): never {
  const err = e as NodeJS.ErrnoException;
  if (err.code === 'ENOENT') {
    throwSourceError({
      kind: 'NotFoundError',
      message: `Not found: ${resource}`,
      resource,
      retryable: false,
    });
  }
  throwSourceError({
    kind: 'NetworkError',
    message: `Filesystem error for ${resource}: ${err.message}`,
    cause: e,
    retryable: true,
  });
}

async function readFileWithCap(
  fs: typeof nodeFsPromises,
  filePath: string,
  cap: number,
): Promise<Uint8Array> {
  let data: Buffer;
  try {
    data = await fs.readFile(filePath) as Buffer;
  } catch (e) {
    mapFsError(e, filePath);
  }
  if (data.byteLength > cap) {
    throwSourceError({
      kind: 'InvalidResponseError',
      message: `File exceeds size cap of ${cap} bytes: ${filePath}`,
      retryable: false,
    });
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

// ---------------------------------------------------------------------------
// LocalFsSource
// ---------------------------------------------------------------------------

export class LocalFsSource implements PackageSource {
  readonly id = 'local-fs' as const;
  readonly displayName: string;

  private readonly rootPath: string;
  private readonly fs: typeof nodeFsPromises;

  constructor(config: LocalFsConfig) {
    this.rootPath = config.rootPath;
    this.fs = config.fs ?? nodeFsPromises;
    this.displayName = `Local filesystem (${config.rootPath})`;
  }

  // -------------------------------------------------------------------------
  // fetchCatalog
  // -------------------------------------------------------------------------

  async fetchCatalog(opts?: {
    etag?: string;
    signal?: AbortSignal;
  }): Promise<CatalogFetchResult> {
    const catalogPath = path.join(this.rootPath, 'catalog.json');
    const sigPath = path.join(this.rootPath, 'catalog.json.sig');

    // Compute ETag from mtime + size
    let stat: Awaited<ReturnType<typeof nodeFsPromises.stat>>;
    try {
      stat = await this.fs.stat(catalogPath);
    } catch (e) {
      mapFsError(e, catalogPath);
    }

    const etag = `${stat.mtimeMs}-${stat.size}`;

    // Conditional: if the etag matches, return notModified
    if (opts?.etag === etag) {
      return { notModified: true, etag };
    }

    opts?.signal?.throwIfAborted();

    const body = await readFileWithCap(this.fs, catalogPath, CAP_CATALOG);
    const sig = await readFileWithCap(this.fs, sigPath, CAP_CATALOG_SIG);

    return { notModified: false, body, sig, etag };
  }

  // -------------------------------------------------------------------------
  // fetchManifest
  // -------------------------------------------------------------------------

  async fetchManifest(
    appId: string,
    version: string,
    opts?: { signal?: AbortSignal },
  ): Promise<ManifestFetchResult> {
    validateAppId(appId);
    validateVersion(version);

    const base = path.join(this.rootPath, 'apps', appId, version);
    assertInsideRoot(this.rootPath, path.resolve(base));

    const manifestPath = path.join(base, 'manifest.json');
    const sigPath = path.join(base, 'manifest.json.sig');

    opts?.signal?.throwIfAborted();

    const body = await readFileWithCap(this.fs, manifestPath, CAP_MANIFEST);
    const sig = await readFileWithCap(this.fs, sigPath, CAP_MANIFEST_SIG);

    return { body, sig };
  }

  // -------------------------------------------------------------------------
  // fetchPayload
  // -------------------------------------------------------------------------

  fetchPayload(
    appId: string,
    version: string,
    opts?: { range?: ByteRange; signal?: AbortSignal },
  ): AsyncIterable<Uint8Array> {
    validateAppId(appId);
    validateVersion(version);

    const payloadPath = path.join(this.rootPath, 'apps', appId, version, 'payload.zip');
    assertInsideRoot(this.rootPath, path.resolve(payloadPath));

    const fs = this.fs;
    const range = opts?.range;
    const signal = opts?.signal;

    return {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        let fileHandle: Awaited<ReturnType<typeof nodeFsPromises.open>> | undefined;
        let done = false;
        let position: number;
        let end: number | undefined;

        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            if (done) return { value: undefined as unknown as Uint8Array, done: true };

            signal?.throwIfAborted();

            try {
              // Open the file on first call
              if (!fileHandle) {
                try {
                  fileHandle = await fs.open(payloadPath, 'r');
                } catch (e) {
                  done = true;
                  mapFsError(e, payloadPath);
                }

                if (range) {
                  position = range.start;
                  end = range.end;
                } else {
                  position = 0;
                  const stat = await fileHandle!.stat();
                  end = stat.size;
                }
              }

              const remaining = end! - position;
              if (remaining <= 0) {
                done = true;
                await fileHandle?.close();
                fileHandle = undefined;
                return { value: undefined as unknown as Uint8Array, done: true };
              }

              const chunkSize = Math.min(CAP_PAYLOAD_CHUNK, remaining);
              const buf = Buffer.allocUnsafe(chunkSize);
              const { bytesRead } = await fileHandle!.read(buf, 0, chunkSize, position);

              if (bytesRead === 0) {
                done = true;
                await fileHandle?.close();
                fileHandle = undefined;
                return { value: undefined as unknown as Uint8Array, done: true };
              }

              position += bytesRead;

              if (position >= end!) {
                done = true;
                await fileHandle?.close();
                fileHandle = undefined;
              }

              return {
                value: new Uint8Array(buf.buffer, buf.byteOffset, bytesRead),
                done: false,
              };
            } catch (e) {
              done = true;
              await fileHandle?.close().catch(() => undefined);
              fileHandle = undefined;
              throw e;
            }
          },

          async return(): Promise<IteratorResult<Uint8Array>> {
            done = true;
            await fileHandle?.close().catch(() => undefined);
            fileHandle = undefined;
            return { value: undefined as unknown as Uint8Array, done: true };
          },
        };
      },
    };
  }

  // -------------------------------------------------------------------------
  // fetchAsset
  // -------------------------------------------------------------------------

  async fetchAsset(
    appId: string,
    version: string,
    assetName: string,
    opts?: { signal?: AbortSignal },
  ): Promise<Uint8Array> {
    validateAppId(appId);
    validateVersion(version);
    validateAssetName(assetName);

    const assetPath = path.join(this.rootPath, 'apps', appId, version, 'assets', assetName);
    const resolved = path.resolve(assetPath);
    assertInsideRoot(this.rootPath, resolved);

    opts?.signal?.throwIfAborted();

    return readFileWithCap(this.fs, assetPath, CAP_ASSET);
  }

  // -------------------------------------------------------------------------
  // listVersions (optional)
  // -------------------------------------------------------------------------

  async listVersions(
    appId: string,
    opts?: { channel?: string; signal?: AbortSignal },
  ): Promise<string[]> {
    validateAppId(appId);

    const appDir = path.join(this.rootPath, 'apps', appId);
    assertInsideRoot(this.rootPath, path.resolve(appDir));

    opts?.signal?.throwIfAborted();

    // Try versions.json first
    const versionsJsonPath = path.join(appDir, 'versions.json');
    try {
      const data = await readFileWithCap(this.fs, versionsJsonPath, CAP_VERSIONS);
      const parsed: unknown = JSON.parse(Buffer.from(data).toString('utf-8'));
      if (!Array.isArray(parsed)) {
        throwSourceError({
          kind: 'InvalidResponseError',
          message: 'versions.json must be an array of semver strings',
          retryable: false,
        });
      }
      const versions = parsed as string[];
      if (opts?.channel) {
        // versions.json does not carry channel info — return all and let caller filter
        return versions;
      }
      return versions;
    } catch (e) {
      // If the error is a SourceError we re-throw it only for InvalidResponseError
      if (
        e instanceof Error &&
        (e as unknown as Record<string, unknown>)['sourceError'] !== undefined
      ) {
        const se = (e as unknown as Record<string, unknown>)['sourceError'] as { kind: string };
        if (se.kind === 'InvalidResponseError') throw e;
        // NotFoundError / NetworkError from versions.json → fall through to directory scan
      } else if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw e;
      }
    }

    // Fall back: scan subdirectory names. Node's typings for fs.readdir
    // expose two overloads (Dirent<NonSharedBuffer> when no encoding is
    // given, Dirent<string> when it is); ours always supplies utf-8 names
    // because callers want strings, but we have to assert the result type
    // to bridge the two surfaces.
    type DirentLike = { name: string; isDirectory(): boolean };
    let entries: DirentLike[];
    try {
      entries = (await this.fs.readdir(appDir, { withFileTypes: true })) as unknown as DirentLike[];
    } catch (e) {
      mapFsError(e, appDir);
    }

    const semverRe =
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

    const versions = entries!
      .filter((d) => d.isDirectory() && semverRe.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => {
        // Reverse semver sort (newest first) — simple lexicographic on split parts
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < 3; i++) {
          const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
          if (diff !== 0) return diff;
        }
        return 0;
      });

    return versions;
  }
}
