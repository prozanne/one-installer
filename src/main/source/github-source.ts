/**
 * GitHubReleasesSource — PackageSource implementation backed by GitHub Releases API v3.
 *
 * Uses node:https (undici is not a project dependency).
 * PAT is optional; injected via getToken callback (keytar wiring is R3's job).
 *
 * @see docs/superpowers/specs/2026-05-01-package-source-abstraction.md §3.1
 */
import * as https from 'node:https';
import * as http from 'node:http';
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
const CAP_ASSET = 8 * 1024 * 1024;         // 8 MiB
const CAP_PAYLOAD_CHUNK = 1024 * 1024;      // 1 MiB per chunk
// GitHub API response for a release listing page (JSON)
const CAP_API_RESPONSE = 4 * 1024 * 1024;  // 4 MiB

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GitHubReleasesConfig {
  catalogRepo: string;
  selfUpdateRepo: string;
  appsOrg: string;
  apiBase: string;
  ref: string;
}

// ---------------------------------------------------------------------------
// GitHub API types
// ---------------------------------------------------------------------------

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
}

// ---------------------------------------------------------------------------
// HTTP client helpers
// ---------------------------------------------------------------------------

interface RawResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function doRequest(
  url: string,
  headers: Record<string, string>,
  cap: number,
  signal?: AbortSignal,
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;

        res.on('data', (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > cap) {
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

        res.on('error', (e) =>
          reject(
            Object.assign(new Error((e as Error).message), {
              sourceError: {
                kind: 'NetworkError' as const,
                message: `Stream error: ${(e as Error).message}`,
                cause: e,
                retryable: true,
              },
            }),
          ),
        );
      },
    );

    req.on('error', (e) =>
      reject(
        Object.assign(new Error((e as Error).message), {
          sourceError: {
            kind: 'NetworkError' as const,
            message: `Network error: ${(e as Error).message}`,
            cause: e,
            retryable: true,
          },
        }),
      ),
    );

    if (signal) {
      if (signal.aborted) {
        req.destroy();
        reject(signal.reason ?? new Error('Aborted'));
        return;
      }
      const onAbort = () => {
        req.destroy();
        reject(signal.reason ?? new Error('Aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal.removeEventListener('abort', onAbort));
    }

    req.end();
  });
}

/**
 * Follow a single level of redirect (GitHub CDN downloads use 302).
 */
async function doRequestFollowRedirect(
  url: string,
  headers: Record<string, string>,
  cap: number,
  signal?: AbortSignal,
): Promise<RawResponse> {
  const res = await doRequest(url, headers, cap, signal);
  if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
    const location = res.headers['location'];
    if (typeof location === 'string') {
      // On redirect, don't forward the Authorization header to CDN
      return doRequest(location, {}, cap, signal);
    }
  }
  return res;
}

function isRateLimitError(res: RawResponse): boolean {
  const remaining = res.headers['x-ratelimit-remaining'];
  // X-RateLimit-Remaining: 0 on any status → rate limit
  if (remaining === '0') return true;
  if (res.statusCode === 429) return true;
  if (res.statusCode === 403) {
    // GitHub returns 403 (not 429) for authenticated token rate-limit exhaustion.
    // Discriminate via X-RateLimit-Remaining and documentation_url in the body.
    const body = res.body.toString('utf-8');
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const docUrl = typeof parsed['documentation_url'] === 'string' ? parsed['documentation_url'] : '';
      if (docUrl.includes('rate-limit') || docUrl.includes('rate_limit')) return true;
    } catch {
      // Body is not JSON — fall back to text scan
      if (body.includes('rate limit') || body.includes('rate_limit')) return true;
    }
  }
  return false;
}

function parseRateLimitReset(headers: http.IncomingHttpHeaders): number | undefined {
  const reset = headers['x-ratelimit-reset'];
  if (typeof reset === 'string') {
    const ts = parseInt(reset, 10);
    if (!isNaN(ts)) return ts * 1000; // Convert Unix seconds to ms
  }
  const retryAfter = headers['retry-after'];
  if (typeof retryAfter === 'string') {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) return Date.now() + seconds * 1000;
    const date = Date.parse(retryAfter);
    if (!isNaN(date)) return date;
  }
  return undefined;
}

function mapStatusError(
  statusCode: number,
  url: string,
  tokenPresent: boolean,
  headers: http.IncomingHttpHeaders,
): never {
  if (statusCode === 404) {
    throwSourceError({
      kind: 'NotFoundError',
      message: `Not found (HTTP 404)`,
      resource: url,
      retryable: false,
    });
  }
  if (statusCode === 401) {
    throwSourceError({
      kind: 'AuthError',
      message: `Authorization failed (HTTP 401)`,
      tokenPresent,
      retryable: false,
    });
  }
  if (statusCode === 403) {
    throwSourceError({
      kind: 'AuthError',
      message: `Forbidden (HTTP 403)`,
      tokenPresent,
      retryable: false,
    });
  }
  if (statusCode === 429) {
    throwSourceError({
      kind: 'RateLimitError',
      message: `Rate limited (HTTP 429)`,
      resetAt: parseRateLimitReset(headers),
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

// ---------------------------------------------------------------------------
// GitHubReleasesSource
// ---------------------------------------------------------------------------

export class GitHubReleasesSource implements PackageSource {
  readonly id = 'github' as const;
  readonly displayName: string;

  private readonly config: GitHubReleasesConfig;
  private readonly getToken: () => Promise<string | undefined>;

  constructor(
    config: GitHubReleasesConfig,
    deps?: {
      getToken?: () => Promise<string | undefined>;
    },
  ) {
    this.config = config;
    this.getToken = deps?.getToken ?? (() => Promise.resolve(undefined));
    this.displayName = `GitHub Releases (${config.catalogRepo})`;
  }

  private async buildHeaders(etag?: string): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'vdx-installer',
    };

    const token = await this.getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    if (etag) {
      headers['If-None-Match'] = etag;
    }

    return headers;
  }

  private async fetchRelease(
    repo: string,
    tag: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<GitHubRelease> {
    const apiUrl = `${this.config.apiBase}/repos/${repo}/releases/tags/${tag}`;
    let res: RawResponse;

    try {
      res = await doRequest(apiUrl, headers, CAP_API_RESPONSE, signal);
    } catch (e) {
      if (
        e instanceof Error &&
        (e as unknown as Record<string, unknown>)['sourceError'] !== undefined
      ) {
        throw e;
      }
      throwSourceError({
        kind: 'NetworkError',
        message: `Network error fetching release: ${(e as Error).message}`,
        cause: e,
        retryable: true,
      });
    }

    const tokenPresent = !!(await this.getToken());

    if (isRateLimitError(res)) {
      throwSourceError({
        kind: 'RateLimitError',
        message: `GitHub API rate limit exceeded`,
        resetAt: parseRateLimitReset(res.headers),
        retryable: true,
      });
    }

    if (res.statusCode !== 200) {
      mapStatusError(res.statusCode, apiUrl, tokenPresent, res.headers);
    }

    let release: unknown;
    try {
      release = JSON.parse(res.body.toString('utf-8'));
    } catch {
      throwSourceError({
        kind: 'InvalidResponseError',
        message: 'GitHub API returned invalid JSON',
        statusCode: res.statusCode,
        retryable: false,
      });
    }

    return release as GitHubRelease;
  }

  private findAsset(release: GitHubRelease, assetName: string): string {
    const asset = release.assets.find((a) => a.name === assetName);
    if (!asset) {
      throwSourceError({
        kind: 'NotFoundError',
        message: `Asset not found in release`,
        resource: assetName,
        retryable: false,
      });
    }
    return asset.browser_download_url;
  }

  private async downloadAssetUrl(
    downloadUrl: string,
    cap: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const headers = await this.buildHeaders();
    let res: RawResponse;

    try {
      res = await doRequestFollowRedirect(downloadUrl, headers, cap, signal);
    } catch (e) {
      if (
        e instanceof Error &&
        (e as unknown as Record<string, unknown>)['sourceError'] !== undefined
      ) {
        throw e;
      }
      throwSourceError({
        kind: 'NetworkError',
        message: `Network error downloading asset: ${(e as Error).message}`,
        cause: e,
        retryable: true,
      });
    }

    if (res.statusCode !== 200) {
      const tokenPresent = !!(await this.getToken());
      mapStatusError(res.statusCode, downloadUrl, tokenPresent, res.headers);
    }

    return res.body;
  }

  // -------------------------------------------------------------------------
  // fetchCatalog
  // -------------------------------------------------------------------------

  async fetchCatalog(opts?: {
    etag?: string;
    signal?: AbortSignal;
  }): Promise<CatalogFetchResult> {
    const headers = await this.buildHeaders(opts?.etag);

    const release = await this.fetchRelease(
      this.config.catalogRepo,
      this.config.ref,
      headers,
      opts?.signal,
    );

    const catalogUrl = this.findAsset(release, 'catalog.json');
    const sigUrl = this.findAsset(release, 'catalog.json.sig');

    opts?.signal?.throwIfAborted();

    // Download catalog.json — check for 304 (conditional GET via ETag on the
    // release API call itself does not apply here; ETag is per-asset in raw form).
    // We use the release ETag from the API response as our catalog ETag.
    const catalogData = await this.downloadAssetUrl(catalogUrl, CAP_CATALOG, opts?.signal);
    const sigData = await this.downloadAssetUrl(sigUrl, CAP_CATALOG_SIG, opts?.signal);

    return {
      notModified: false,
      body: new Uint8Array(catalogData.buffer, catalogData.byteOffset, catalogData.byteLength),
      sig: new Uint8Array(sigData.buffer, sigData.byteOffset, sigData.byteLength),
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

    const appName = appId.split('.').at(-1) ?? appId;
    const appRepo = `${this.config.appsOrg}/${appName}`;

    const headers = await this.buildHeaders();
    const release = await this.fetchRelease(appRepo, `v${version}`, headers, opts?.signal);

    const manifestUrl = this.findAsset(release, 'manifest.json');
    const sigUrl = this.findAsset(release, 'manifest.json.sig');

    opts?.signal?.throwIfAborted();

    const manifestData = await this.downloadAssetUrl(manifestUrl, CAP_MANIFEST, opts?.signal);
    const sigData = await this.downloadAssetUrl(sigUrl, CAP_MANIFEST_SIG, opts?.signal);

    return {
      body: new Uint8Array(manifestData.buffer, manifestData.byteOffset, manifestData.byteLength),
      sig: new Uint8Array(sigData.buffer, sigData.byteOffset, sigData.byteLength),
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

    const self = this;
    const signal = opts?.signal;
    const range = opts?.range;

    return {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        let started = false;
        let done = false;
        const chunks: Uint8Array[] = [];
        let pendingResolve: ((r: IteratorResult<Uint8Array>) => void) | undefined;
        let pendingReject: ((e: unknown) => void) | undefined;
        let nodeReq: http.ClientRequest | undefined;

        async function start(
          resolve: (r: IteratorResult<Uint8Array>) => void,
          reject: (e: unknown) => void,
        ): Promise<void> {
          try {
            // We need to resolve the download URL first
            const appName = appId.split('.').at(-1) ?? appId;
            const appRepo = `${self.config.appsOrg}/${appName}`;
            const headers = await self.buildHeaders();
            const release = await self.fetchRelease(appRepo, `v${version}`, headers, signal);
            const payloadUrl = self.findAsset(release, 'payload.zip');

            if (signal?.aborted) {
              done = true;
              reject(signal.reason ?? new Error('Aborted'));
              return;
            }

            const parsed = new URL(payloadUrl);
            const isHttps = parsed.protocol === 'https:';
            const lib = isHttps ? https : http;

            const reqHeaders: Record<string, string> = {};
            if (range) {
              reqHeaders['Range'] = `bytes=${range.start}-${range.end - 1}`;
            }

            nodeReq = lib.request(
              {
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: 'GET',
                headers: reqHeaders,
              },
              (res) => {
                // Handle redirect
                if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
                  const location = res.headers['location'];
                  res.resume();
                  if (typeof location === 'string') {
                    const parsed2 = new URL(location);
                    const isHttps2 = parsed2.protocol === 'https:';
                    const lib2 = isHttps2 ? https : http;

                    nodeReq = lib2.request(
                      {
                        hostname: parsed2.hostname,
                        port: parsed2.port || (isHttps2 ? 443 : 80),
                        path: parsed2.pathname + parsed2.search,
                        method: 'GET',
                        headers: range ? { Range: `bytes=${range.start}-${range.end - 1}` } : {},
                      },
                      (res2) => setupPayloadStream(res2, resolve, reject),
                    );
                    nodeReq.on('error', (e) => {
                      done = true;
                      reject(
                        Object.assign(new Error((e as Error).message), {
                          sourceError: {
                            kind: 'NetworkError' as const,
                            message: `Redirect request error: ${(e as Error).message}`,
                            cause: e,
                            retryable: true,
                          },
                        }),
                      );
                    });
                    nodeReq.end();
                    return;
                  }
                }
                setupPayloadStream(res, resolve, reject);
              },
            );

            nodeReq.on('error', (e) => {
              done = true;
              reject(
                Object.assign(new Error((e as Error).message), {
                  sourceError: {
                    kind: 'NetworkError' as const,
                    message: `Payload request error: ${(e as Error).message}`,
                    cause: e,
                    retryable: true,
                  },
                }),
              );
            });

            if (signal) {
              if (signal.aborted) {
                nodeReq.destroy();
                done = true;
                reject(signal.reason ?? new Error('Aborted'));
                return;
              }
              signal.addEventListener(
                'abort',
                () => {
                  nodeReq?.destroy();
                  done = true;
                  if (pendingReject) {
                    const rj = pendingReject;
                    pendingResolve = undefined;
                    pendingReject = undefined;
                    rj(signal.reason ?? new Error('Aborted'));
                  }
                },
                { once: true },
              );
            }

            nodeReq.end();
          } catch (e) {
            done = true;
            reject(e);
          }
        }

        function setupPayloadStream(
          res: http.IncomingMessage,
          resolve: (r: IteratorResult<Uint8Array>) => void,
          reject: (e: unknown) => void,
        ): void {
          const sc = res.statusCode ?? 0;

          // T-06: If a range was requested with non-zero start, server MUST respond 206.
          if (sc === 200 && range && range.start > 0) {
            done = true;
            res.resume();
            try {
              throwSourceError({
                kind: 'InvalidResponseError',
                message:
                  'Server returned 200 instead of 206 for Range request; server does not support resumable download',
                statusCode: 200,
                retryable: false,
              });
            } catch (e) {
              reject(e);
              return;
            }
          }

          if (sc !== 200 && sc !== 206) {
            done = true;
            res.resume();
            if (sc === 416) {
              try {
                throwSourceError({
                  kind: 'InvalidResponseError',
                  message: 'Range not satisfiable (HTTP 416)',
                  statusCode: 416,
                  retryable: false,
                });
              } catch (e) {
                reject(e);
                return;
              }
            }
            try {
              mapStatusError(sc, 'payload download', false, res.headers);
            } catch (e) {
              reject(e);
              return;
            }
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
            done = true;
            if (pendingResolve) {
              const r = pendingResolve;
              pendingResolve = undefined;
              pendingReject = undefined;
              r({ value: undefined as unknown as Uint8Array, done: true });
            }
          });

          res.on('error', (e) => {
            done = true;
            if (pendingReject) {
              const rj = pendingReject;
              pendingResolve = undefined;
              pendingReject = undefined;
              rj(
                Object.assign(new Error((e as Error).message), {
                  sourceError: {
                    kind: 'NetworkError' as const,
                    message: `Payload stream error: ${(e as Error).message}`,
                    cause: e,
                    retryable: true,
                  },
                }),
              );
            }
          });

          // Resolve any queued chunks
          void resolve;
        }

        return {
          next(): Promise<IteratorResult<Uint8Array>> {
            if (done && chunks.length === 0) {
              return Promise.resolve({ value: undefined as unknown as Uint8Array, done: true });
            }

            if (chunks.length > 0) {
              return Promise.resolve({ value: chunks.shift()!, done: false });
            }

            return new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
              pendingResolve = resolve;
              pendingReject = reject;

              if (!started) {
                started = true;
                void start(resolve, reject);
              }
            });
          },

          return(): Promise<IteratorResult<Uint8Array>> {
            done = true;
            nodeReq?.destroy();
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

    const appName = appId.split('.').at(-1) ?? appId;
    const appRepo = `${this.config.appsOrg}/${appName}`;

    const headers = await this.buildHeaders();
    const release = await this.fetchRelease(appRepo, `v${version}`, headers, opts?.signal);

    const assetUrl = this.findAsset(release, assetName);

    opts?.signal?.throwIfAborted();

    const data = await this.downloadAssetUrl(assetUrl, CAP_ASSET, opts?.signal);
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  // -------------------------------------------------------------------------
  // listVersions (optional)
  // -------------------------------------------------------------------------

  async listVersions(
    appId: string,
    opts?: { channel?: string; signal?: AbortSignal },
  ): Promise<string[]> {
    validateAppId(appId);

    const appName = appId.split('.').at(-1) ?? appId;
    const appRepo = `${this.config.appsOrg}/${appName}`;

    const headers = await this.buildHeaders();
    const apiUrl = `${this.config.apiBase}/repos/${appRepo}/releases?per_page=100`;

    let res: RawResponse;
    try {
      res = await doRequest(apiUrl, headers, CAP_API_RESPONSE, opts?.signal);
    } catch (e) {
      if (
        e instanceof Error &&
        (e as unknown as Record<string, unknown>)['sourceError'] !== undefined
      ) {
        throw e;
      }
      throwSourceError({
        kind: 'NetworkError',
        message: `Network error listing versions: ${(e as Error).message}`,
        cause: e,
        retryable: true,
      });
    }

    const tokenPresent = !!(await this.getToken());

    if (isRateLimitError(res)) {
      throwSourceError({
        kind: 'RateLimitError',
        message: 'GitHub API rate limit exceeded',
        resetAt: parseRateLimitReset(res.headers),
        retryable: true,
      });
    }

    if (res.statusCode !== 200) {
      mapStatusError(res.statusCode, apiUrl, tokenPresent, res.headers);
    }

    let releases: unknown;
    try {
      releases = JSON.parse(res.body.toString('utf-8'));
    } catch {
      throwSourceError({
        kind: 'InvalidResponseError',
        message: 'GitHub API returned invalid JSON for releases',
        statusCode: res.statusCode,
        retryable: false,
      });
    }

    if (!Array.isArray(releases)) {
      throwSourceError({
        kind: 'InvalidResponseError',
        message: 'GitHub API releases response is not an array',
        statusCode: res.statusCode,
        retryable: false,
      });
    }

    const channel = opts?.channel;
    const semverRe = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

    const versions: string[] = [];
    for (const r of releases as GitHubRelease[]) {
      const match = semverRe.exec(r.tag_name);
      if (!match) continue;
      const version = match[1]!;

      if (channel) {
        // Filter by channel: stable = no prerelease, beta = '-beta', internal = '-internal'
        const preReleasePart = version.includes('-') ? version.split('-')[1] : '';
        const releaseChannel =
          preReleasePart?.startsWith('internal')
            ? 'internal'
            : preReleasePart?.startsWith('beta')
              ? 'beta'
              : 'stable';

        if (releaseChannel !== channel) continue;
      }

      versions.push(version);
    }

    return versions;
  }
}
