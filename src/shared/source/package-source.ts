/**
 * PackageSource abstraction — the single interface that all source backends implement.
 *
 * @see docs/superpowers/specs/2026-05-01-package-source-abstraction.md §2
 */

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/** A half-open byte range [start, end). Equivalent to HTTP Range: bytes=start-{end-1}. */
export interface ByteRange {
  start: number; // inclusive, bytes from start of file
  end: number;   // exclusive
}

/**
 * Returned by fetchCatalog. The etag is opaque to the caller;
 * it is stored and supplied back on the next call for conditional GET.
 */
export interface CatalogFetchResult {
  /** `notModified` means caller's cached copy is still valid. `body` is undefined. */
  notModified: boolean;
  /** Raw bytes of catalog.json when notModified === false. */
  body?: Uint8Array;
  /** Raw bytes of catalog.json.sig when notModified === false. */
  sig?: Uint8Array;
  /** Opaque cache-validation token (ETag or Last-Modified value). */
  etag?: string;
}

/** Returned by fetchManifest. Always returns the raw bytes; caller owns parsing. */
export interface ManifestFetchResult {
  /** Raw bytes of manifest.json. */
  body: Uint8Array;
  /** Raw bytes of manifest.json.sig. */
  sig: Uint8Array;
}

// ---------------------------------------------------------------------------
// Error union
// ---------------------------------------------------------------------------

/** Discriminated-union error type for all source operations. */
export type SourceError =
  | NetworkError
  | NotFoundError
  | AuthError
  | RateLimitError
  | InvalidResponseError;

export interface NetworkError {
  kind: 'NetworkError';
  message: string;
  cause?: unknown;
  retryable: true;
}

export interface NotFoundError {
  kind: 'NotFoundError';
  message: string;
  /** e.g. the URL or path that was not found */
  resource: string;
  retryable: false;
}

export interface AuthError {
  kind: 'AuthError';
  message: string;
  /** true if a token exists but is rejected; false if no token was provided */
  tokenPresent: boolean;
  retryable: false;
}

export interface RateLimitError {
  kind: 'RateLimitError';
  message: string;
  /** Unix epoch ms when the rate limit resets; undefined if not available */
  resetAt?: number;
  retryable: true;
}

export interface InvalidResponseError {
  kind: 'InvalidResponseError';
  message: string;
  /** HTTP status code, if applicable */
  statusCode?: number;
  retryable: false;
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/** Factory helper to build a SourceError and throw it. */
export function throwSourceError(e: SourceError): never {
  const err = new Error(e.message);
  (err as unknown as Record<string, unknown>)['sourceError'] = e;
  throw err;
}

/** Type-guard to extract a SourceError from a caught value. */
export function isSourceError(e: unknown): e is Error & { sourceError: SourceError } {
  if (!(e instanceof Error)) return false;
  const tagged = (e as unknown as Record<string, unknown>)['sourceError'];
  // `typeof null === 'object'` so the `!== null` check is required to keep the
  // narrowed `sourceError: SourceError` (non-null) type honest.
  if (tagged === null || typeof tagged !== 'object') return false;
  // Cheap shape check: every SourceError variant has a string `kind`.
  return typeof (tagged as Record<string, unknown>)['kind'] === 'string';
}

// ---------------------------------------------------------------------------
// PackageSource interface
// ---------------------------------------------------------------------------

/**
 * Abstraction for the backend that serves the catalog, manifests, and payloads.
 *
 * Implementations must be:
 * - Stateless w.r.t. in-flight requests (each call is independent).
 * - Safe to call concurrently.
 * - Responsible for throwing SourceError-wrapped errors on failure.
 * - NOT responsible for Ed25519 signature verification (caller does that).
 * - NOT responsible for payload sha256 verification (caller does that).
 *
 * Implementations MUST NOT make any assumptions about which app IDs or versions
 * exist; that is the catalog's job.
 */
export interface PackageSource {
  /** Stable identifier for the source type. Used in logs and config validation only. */
  readonly id: 'github' | 'http-mirror' | 'local-fs';

  /** Human-readable label for display in settings / diagnostics. */
  readonly displayName: string;

  /**
   * Fetch the current catalog.
   *
   * @param opts.etag  Opaque token from a prior CatalogFetchResult.etag.
   *                   When supplied, implementations SHOULD issue a conditional
   *                   request (HTTP ETag / If-None-Match, or file mtime check).
   * @param opts.signal  AbortSignal for cancellation.
   *
   * Throws SourceError on failure.
   * Returns { notModified: true } when etag matches (no re-download needed).
   */
  fetchCatalog(opts?: {
    etag?: string;
    signal?: AbortSignal;
  }): Promise<CatalogFetchResult>;

  /**
   * Fetch the manifest.json + manifest.json.sig for a specific app version.
   *
   * @param appId    Reverse-DNS app identifier (e.g. "com.samsung.vdx.exampleapp").
   * @param version  Semver string (e.g. "1.2.3").
   *
   * Throws NotFoundError if the version does not exist.
   * Throws SourceError on other failures.
   */
  fetchManifest(
    appId: string,
    version: string,
    opts?: { signal?: AbortSignal },
  ): Promise<ManifestFetchResult>;

  /**
   * Stream the payload.zip for a specific app version.
   *
   * Yields chunks of raw bytes in order. The caller accumulates or pipes
   * them. The caller is responsible for sha256 verification after streaming.
   *
   * @param opts.range  If provided, fetch only [start, end) bytes (for resume).
   *                    Implementations that do not support Range MUST throw
   *                    an InvalidResponseError rather than silently ignoring.
   * @param opts.signal  AbortSignal for cancellation.
   *
   * Throws SourceError on failure.
   */
  fetchPayload(
    appId: string,
    version: string,
    opts?: { range?: ByteRange; signal?: AbortSignal },
  ): AsyncIterable<Uint8Array>;

  /**
   * Fetch a named asset (e.g. "icon.png", "EULA.txt", "screenshots/01.png").
   * Assets are small; returned as a single buffer.
   *
   * Throws NotFoundError if the asset does not exist.
   * Throws SourceError on other failures.
   */
  fetchAsset(
    appId: string,
    version: string,
    assetName: string,
    opts?: { signal?: AbortSignal },
  ): Promise<Uint8Array>;

  /**
   * List all available versions for a given appId, newest first.
   * Optional — implement only when the source supports it.
   * Used by the self-update checker.
   *
   * @param opts.channel  If provided, filter to versions tagged with this channel.
   *
   * Throws SourceError on failure.
   */
  listVersions?(
    appId: string,
    opts?: { channel?: string; signal?: AbortSignal },
  ): Promise<string[]>;
}
