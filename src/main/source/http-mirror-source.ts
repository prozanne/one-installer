/**
 * HttpMirrorSource — PackageSource implementation backed by an HTTP/HTTPS mirror.
 *
 * Uses node:https / node:http (undici is not a project dependency).
 *
 * @see docs/superpowers/specs/2026-05-01-package-source-abstraction.md §3.2
 */
import * as https from 'node:https';
import * as http from 'node:http';
import { Readable } from 'node:stream';
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

export interface HttpMirrorConfig {
  /**
   * Base URL of the mirror. Must end without a trailing slash.
   * Example: "https://vdx.example.com"
   */
  baseUrl: string;

  /**
   * Optional bearer token for authenticated mirrors.
   * If set, added as Authorization: Bearer <token> on all requests.
   */
  token?: string;

  /**
   * Optional proxy override for this source only.
   */
  proxyUrl?: string;
}

// ---------------------------------------------------------------------------
// HTTP client helpers
// ---------------------------------------------------------------------------

interface RequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  rangeBytes?: ByteRange;
}

interface RawResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * Minimal HTTP GET wrapper using node:https/node:http.
 * Collects the response body into a Buffer and enforces a size cap.
 */
function requestRaw(opts: RequestOptions & { cap: number }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(opts.url);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const headers: Record<string, string> = { ...opts.headers };
    if (opts.rangeBytes) {
      headers['Range'] = `bytes=${opts.rangeBytes.start}-${opts.rangeBytes.end - 1}`;
    }

    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: opts.method ?? 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;

        res.on('data', (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > opts.cap) {
            req.destroy();
            reject(
              Object.assign(new Error('Response exceeds size cap'), {
                sourceError: {
                  kind: 'InvalidResponseError' as const,
                  message: 'Response body exceeds allowed size',
                  statusCode: res.statusCode,
                  retryable: false,
                },
              }),
            );
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });

        res.on('error', reject);
      },
    );

    req.on('error', (e) => {
      reject(
        Object.assign(new Error((e as Error).message), {
          sourceError: {
            kind: 'NetworkError' as const,
            message: `Network error: ${(e as Error).message}`,
            cause: e,
            retryable: true,
          },
        }),
      );
    });

    if (opts.signal) {
      const onAbort = () => {
        req.destroy();
        reject(opts.signal!.reason ?? new Error('Aborted'));
      };
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => opts.signal!.removeEventListener('abort', onAbort));
    }

    req.end();
  });
}

function mapStatusError(statusCode: number, url: string, tokenPresent: boolean): never {
  if (statusCode === 404) {
    throwSourceError({
      kind: 'NotFoundError',
      message: `Not found (HTTP 404)`,
      resource: url,
      retryable: false,
    });
  }
  if (statusCode === 401 || statusCode === 403) {
    throwSourceError({
      kind: 'AuthError',
      message: `Authorization failed (HTTP ${statusCode})`,
      tokenPresent,
      retryable: false,
    });
  }
  if (statusCode === 429) {
    throwSourceError({
      kind: 'RateLimitError',
      message: `Rate limited (HTTP 429)`,
      retryable: true,
    });
  }
  if (statusCode >= 500) {
    throwSourceError({
      kind: 'NetworkError',
      message: `Server error (HTTP ${statusCode})`,
      retryable: true,
    });
  }
  throwSourceError({
    kind: 'InvalidResponseError',
    message: `Unexpected HTTP status ${statusCode}`,
    statusCode,
    retryable: false,
  });
}

function parseRetryAfter(headers: http.IncomingHttpHeaders): number | undefined {
  const ra = headers['retry-after'];
  if (!ra) return undefined;
  const seconds = parseInt(ra, 10);
  if (!isNaN(seconds)) return Date.now() + seconds * 1000;
  const date = Date.parse(ra);
  if (!isNaN(date)) return date;
  return undefined;
}

// ---------------------------------------------------------------------------
// HttpMirrorSource
// ---------------------------------------------------------------------------

export class HttpMirrorSource implements PackageSource {
  readonly id = 'http-mirror' as const;
  readonly displayName: string;

  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly tokenPresent: boolean;

  constructor(config: HttpMirrorConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.token = config.token;
    this.tokenPresent = config.token !== undefined && config.token.length > 0;
    this.displayName = `HTTP mirror (${this.baseUrl})`;
  }

  private get authHeaders(): Record<string, string> {
    if (this.token) {
      return { Authorization: `Bearer ${this.token}` };
    }
    return {};
  }

  // -------------------------------------------------------------------------
  // fetchCatalog
  // -------------------------------------------------------------------------

  async fetchCatalog(opts?: {
    etag?: string;
    signal?: AbortSignal;
  }): Promise<CatalogFetchResult> {
    const catalogUrl = `${this.baseUrl}/catalog.json`;
    const sigUrl = `${this.baseUrl}/catalog.json.sig`;

    const headers: Record<string, string> = { ...this.authHeaders };
    if (opts?.etag) {
      headers['If-None-Match'] = opts.etag;
    }

    let res: RawResponse;
    try {
      res = await requestRaw({
        url: catalogUrl,
        headers,
        signal: opts?.signal,
        cap: CAP_CATALOG,
      });
    } catch (e) {
      if (
        e instanceof Error &&
        (e as unknown as Record<string, unknown>)['sourceError'] !== undefined
      ) {
        throw e;
      }
      throwSourceError({
        kind: 'NetworkError',
        message: `Network error fetching catalog: ${(e as Error).message}`,
        cause: e,
        retryable: true,
      });
    }

    if (res.statusCode === 304) {
      return { notModified: true, etag: opts?.etag };
    }

    if (res.statusCode !== 200) {
      if (res.statusCode === 429) {
        throwSourceError({
          kind: 'RateLimitError',
          message: 'Rate limited fetching catalog',
          resetAt: parseRetryAfter(res.headers),
          retryable: true,
        });
      }
      mapStatusError(res.statusCode, catalogUrl, this.tokenPresent);
    }

    const etag = (res.headers['etag'] as string | undefined);

    opts?.signal?.throwIfAborted();

    // Fetch sig
    let sigRes: RawResponse;
    try {
      sigRes = await requestRaw({
        url: sigUrl,
        headers: this.authHeaders,
        signal: opts?.signal,
        cap: CAP_CATALOG_SIG,
      });
    } catch (e) {
      if (
        e instanceof Error &&
        (e as unknown as Record<string, unknown>)['sourceError'] !== undefined
      ) {
        throw e;
      }
      throwSourceError({
        kind: 'NetworkError',
        message: `Network error fetching catalog sig: ${(e as Error).message}`,
        cause: e,
        retryable: true,
      });
    }

    if (sigRes.statusCode !== 200) {
      mapStatusError(sigRes.statusCode, sigUrl, this.tokenPresent);
    }

    return {
      notModified: false,
      body: new Uint8Array(res.body.buffer, res.body.byteOffset, res.body.byteLength),
      sig: new Uint8Array(sigRes.body.buffer, sigRes.body.byteOffset, sigRes.body.byteLength),
      etag,
    };
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

    const base = `${this.baseUrl}/apps/${encodeURIComponent(appId)}/${encodeURIComponent(version)}`;
    const manifestUrl = `${base}/manifest.json`;
    const sigUrl = `${base}/manifest.json.sig`;

    opts?.signal?.throwIfAborted();

    let res: RawResponse;
    try {
      res = await requestRaw({
        url: manifestUrl,
        headers: this.authHeaders,
        signal: opts?.signal,
        cap: CAP_MANIFEST,
      });
    } catch (e) {
      if (
        e instanceof Error &&
        (e as unknown as Record<string, unknown>)['sourceError'] !== undefined
      ) {
        throw e;
      }
      throwSourceError({
        kind: 'NetworkError',
        message: `Network error fetching manifest: ${(e as Error).message}`,
        cause: e,
        retryable: true,
      });
    }

    if (res.statusCode !== 200) {
      mapStatusError(res.statusCode, manifestUrl, this.tokenPresent);
    }

    let sigRes: RawResponse;
    try {
      sigRes = await requestRaw({
        url: sigUrl,
        headers: this.authHeaders,
        signal: opts?.signal,
        cap: CAP_MANIFEST_SIG,
      });
    } catch (e) {
      if (
        e instanceof Error &&
        (e as unknown as Record<string, unknown>)['sourceError'] !== undefined
      ) {
        throw e;
      }
      throwSourceError({
        kind: 'NetworkError',
        message: `Network error fetching manifest sig: ${(e as Error).message}`,
        cause: e,
        retryable: true,
      });
    }

    if (sigRes.statusCode !== 200) {
      mapStatusError(sigRes.statusCode, sigUrl, this.tokenPresent);
    }

    return {
      body: new Uint8Array(res.body.buffer, res.body.byteOffset, res.body.byteLength),
      sig: new Uint8Array(sigRes.body.buffer, sigRes.body.byteOffset, sigRes.body.byteLength),
    };
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

    const payloadUrl = `${this.baseUrl}/apps/${encodeURIComponent(appId)}/${encodeURIComponent(version)}/payload.zip`;
    const headers: Record<string, string> = { ...this.authHeaders };
    if (opts?.range) {
      headers['Range'] = `bytes=${opts.range.start}-${opts.range.end - 1}`;
    }
    const signal = opts?.signal;
    const range = opts?.range;
    const tokenPresent = this.tokenPresent;

    return {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        let nodeStream: Readable | undefined;
        let streamDone = false;
        let pendingResolve: ((result: IteratorResult<Uint8Array>) => void) | undefined;
        let pendingReject: ((e: unknown) => void) | undefined;
        const chunks: Uint8Array[] = [];

        function setupStream(
          res: http.IncomingMessage,
          resolve: (r: IteratorResult<Uint8Array>) => void,
          reject: (e: unknown) => void,
        ): void {
          nodeStream = res;

          // T-06: If a range was requested with non-zero start, server MUST respond 206.
          // A 200 response to a range request means the server ignored the Range header
          // and returned the full file from byte 0 — this would silently corrupt a resume.
          if (res.statusCode === 200 && range && range.start > 0) {
            streamDone = true;
            res.resume();
            throwSourceError({
              kind: 'InvalidResponseError',
              message:
                'Server returned 200 instead of 206 for Range request; server does not support resumable download',
              statusCode: 200,
              retryable: false,
            });
          }

          if (res.statusCode !== 200 && res.statusCode !== 206) {
            streamDone = true;
            // Drain and map error
            const sc = res.statusCode ?? 0;
            res.resume();
            if (sc === 404) {
              throwSourceError({
                kind: 'NotFoundError',
                message: 'Payload not found (HTTP 404)',
                resource: payloadUrl,
                retryable: false,
              });
            }
            if (sc === 416) {
              // Range not satisfiable — surface as InvalidResponseError
              throwSourceError({
                kind: 'InvalidResponseError',
                message: 'Range not satisfiable (HTTP 416)',
                statusCode: 416,
                retryable: false,
              });
            }
            mapStatusError(sc, payloadUrl, tokenPresent);
          }

          res.on('data', (chunk: Buffer) => {
            const sliced = new Uint8Array(
              chunk.buffer,
              chunk.byteOffset,
              Math.min(chunk.byteLength, CAP_PAYLOAD_CHUNK),
            );
            if (pendingResolve) {
              const r = pendingResolve;
              pendingResolve = undefined;
              pendingReject = undefined;
              r({ value: sliced, done: false });
            } else {
              chunks.push(sliced);
            }
          });

          res.on('end', () => {
            streamDone = true;
            if (pendingResolve) {
              const r = pendingResolve;
              pendingResolve = undefined;
              pendingReject = undefined;
              r({ value: undefined as unknown as Uint8Array, done: true });
            }
          });

          res.on('error', (e) => {
            streamDone = true;
            if (pendingReject) {
              const rj = pendingReject;
              pendingResolve = undefined;
              pendingReject = undefined;
              rj(
                Object.assign(new Error((e as Error).message), {
                  sourceError: {
                    kind: 'NetworkError' as const,
                    message: `Stream error: ${(e as Error).message}`,
                    cause: e,
                    retryable: true,
                  },
                }),
              );
            }
          });

          // Kick off first resolve if already called
          void resolve;
        }

        let requestStarted = false;

        return {
          next(): Promise<IteratorResult<Uint8Array>> {
            if (streamDone && chunks.length === 0) {
              return Promise.resolve({ value: undefined as unknown as Uint8Array, done: true });
            }

            if (chunks.length > 0) {
              return Promise.resolve({ value: chunks.shift()!, done: false });
            }

            return new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
              pendingResolve = resolve;
              pendingReject = reject;

              if (!requestStarted) {
                requestStarted = true;
                const url = new URL(payloadUrl);
                const isHttps = url.protocol === 'https:';
                const lib = isHttps ? https : http;

                const req = lib.request(
                  {
                    hostname: url.hostname,
                    port: url.port || (isHttps ? 443 : 80),
                    path: url.pathname + url.search,
                    method: 'GET',
                    headers,
                  },
                  (res) => setupStream(res, resolve, reject),
                );

                req.on('error', (e) => {
                  streamDone = true;
                  reject(
                    Object.assign(new Error((e as Error).message), {
                      sourceError: {
                        kind: 'NetworkError' as const,
                        message: `Request error: ${(e as Error).message}`,
                        cause: e,
                        retryable: true,
                      },
                    }),
                  );
                });

                if (signal) {
                  const onAbort = () => {
                    req.destroy();
                    nodeStream?.destroy();
                    streamDone = true;
                    reject(signal.reason ?? new Error('Aborted'));
                  };
                  if (signal.aborted) {
                    onAbort();
                    return;
                  }
                  signal.addEventListener('abort', onAbort, { once: true });
                }

                req.end();
              }
            });
          },

          return(): Promise<IteratorResult<Uint8Array>> {
            streamDone = true;
            nodeStream?.destroy();
            return Promise.resolve({ value: undefined as unknown as Uint8Array, done: true });
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

    const assetUrl = `${this.baseUrl}/apps/${encodeURIComponent(appId)}/${encodeURIComponent(version)}/assets/${assetName}`;

    opts?.signal?.throwIfAborted();

    let res: RawResponse;
    try {
      res = await requestRaw({
        url: assetUrl,
        headers: this.authHeaders,
        signal: opts?.signal,
        cap: CAP_ASSET,
      });
    } catch (e) {
      if (
        e instanceof Error &&
        (e as unknown as Record<string, unknown>)['sourceError'] !== undefined
      ) {
        throw e;
      }
      throwSourceError({
        kind: 'NetworkError',
        message: `Network error fetching asset: ${(e as Error).message}`,
        cause: e,
        retryable: true,
      });
    }

    if (res.statusCode !== 200) {
      mapStatusError(res.statusCode, assetUrl, this.tokenPresent);
    }

    return new Uint8Array(res.body.buffer, res.body.byteOffset, res.body.byteLength);
  }

  // -------------------------------------------------------------------------
  // listVersions (optional)
  // -------------------------------------------------------------------------

  async listVersions(
    appId: string,
    opts?: { channel?: string; signal?: AbortSignal },
  ): Promise<string[]> {
    validateAppId(appId);

    const versionsUrl = `${this.baseUrl}/apps/${encodeURIComponent(appId)}/versions.json`;

    opts?.signal?.throwIfAborted();

    let res: RawResponse;
    try {
      res = await requestRaw({
        url: versionsUrl,
        headers: this.authHeaders,
        signal: opts?.signal,
        cap: CAP_VERSIONS,
      });
    } catch (e) {
      if (
        e instanceof Error &&
        (e as unknown as Record<string, unknown>)['sourceError'] !== undefined
      ) {
        throw e;
      }
      throwSourceError({
        kind: 'NetworkError',
        message: `Network error fetching versions: ${(e as Error).message}`,
        cause: e,
        retryable: true,
      });
    }

    if (res.statusCode === 404) {
      throwSourceError({
        kind: 'NotFoundError',
        message: 'versions.json not found',
        resource: versionsUrl,
        retryable: false,
      });
    }

    if (res.statusCode !== 200) {
      mapStatusError(res.statusCode, versionsUrl, this.tokenPresent);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body.toString('utf-8'));
    } catch {
      throwSourceError({
        kind: 'InvalidResponseError',
        message: 'versions.json is not valid JSON',
        statusCode: res.statusCode,
        retryable: false,
      });
    }

    if (!Array.isArray(parsed)) {
      throwSourceError({
        kind: 'InvalidResponseError',
        message: 'versions.json must be an array of semver strings',
        statusCode: res.statusCode,
        retryable: false,
      });
    }

    return parsed as string[];
  }
}
