# VDX Installer — Package Source Abstraction Spec

**Date:** 2026-05-01
**Status:** Draft v1
**Scope:** Extension to `2026-05-01-vdx-installer-design.md`. Defines a clean abstraction layer so the archive backend (GitHub, HTTP mirror, local filesystem) is swappable via a single config file without rebuilding the installer.

**Relationship to the main design.** Most additions here are additive (new files under `src/main/source/`, new config schema). However, the following decisions in this spec **supersede** earlier choices in the main design and should land alongside Phase 2:

| Topic | Earlier (main design) | This spec |
|---|---|---|
| Catalog URL | Raw branch blob (`raw.githubusercontent.com/.../main/catalog.json`) | Tagged Release asset (§3.1) |
| Trust model | Single embedded Ed25519 key | Embedded key ∪ optional `trustRoots` (additive only — §4.6 T1) |
| `developerMode` | Single per-user `installed.json.settings.developerMode` toggle | Policy ceiling in `vdx.config.json` AND user opt-in in `installed.json.settings`; both required (§4.2 + §4.6 T8) |
| PAT keychain account name | `vdx-installer:github` | `service: 'vdx-installer', account: 'github-pat'` (§3.1) |
| `installed.json.source` enum | `'catalog' \| 'sideload'` | Adds optional `installed.json.sourceBackend` (§5.1.1) |

These are flagged here so the design-spec owner can reconcile in one merge rather than discovering drift during implementation.

---

## 1. Goal & Non-Goals

### 1.1. Goal

- The archive URL (catalog location, manifest location, payload location) is controlled by a single `vdx.config.json` file readable at runtime.
- Swapping from GitHub Releases to an HTTP mirror or an on-premises GitLab instance requires only editing that config file — no recompile, no code change, no registry tweak.
- The engine core (Phase 1.0) has zero hardcoded references to `"github"`, `samsung/vdx-catalog`, `api.github.com`, or any org-specific string outside `config-defaults.ts`.
- The abstraction is available in Phase 1.0 as a `LocalFsSource` stub so the engine is testable without a network. Real sources arrive in Phase 2 (network/catalog phase).

### 1.2. Non-Goals

- Live multi-source aggregation (fetching from two backends and merging results). One active source at a time.
- Per-app source overrides selectable at runtime UI. Source is global, set in config.
- Fallback chain between sources on error. Errors surface loudly; there is no silent fallback.
- Automatic source discovery or mDNS/Bonjour scan.
- Signed `vdx.config.json` (the config is operator-controlled; trust comes from the catalog sig inside it).

---

## 2. `PackageSource` Interface

**File:** `src/shared/source/package-source.ts`

### 2.1. Supporting types

```ts
/** A half-open byte range [start, end). Equivalent to HTTP Range: bytes=start-{end-1}. */
export interface ByteRange {
  start: number;  // inclusive, bytes from start of file
  end: number;    // exclusive
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

/**
 * Base class for every error thrown by a PackageSource implementation.
 * Concrete subclasses each carry a string-literal `kind` discriminator so
 * callers can switch exhaustively. Using real Error subclasses (rather than
 * an internal-tag pattern) keeps `instanceof`, `Error.cause`, and stack-trace
 * inspection working through IPC and telemetry boundaries.
 *
 * Every constructor MUST run any user-controlled string (URL, path, token,
 * response body) through `redact.ts` before passing it as `message` so that
 * the resulting Error is safe to log, serialise, or include in a crash dump
 * without further sanitisation. (See §4.5.)
 */
export abstract class SourceError extends Error {
  abstract readonly kind:
    | 'NetworkError'
    | 'NotFoundError'
    | 'AuthError'
    | 'RateLimitError'
    | 'IoError'
    | 'InvalidResponseError';
  abstract readonly retryable: boolean;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class NetworkError extends SourceError {
  readonly kind = 'NetworkError' as const;
  readonly retryable = true as const;
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts);
  }
}

export class NotFoundError extends SourceError {
  readonly kind = 'NotFoundError' as const;
  readonly retryable = false as const;
  /** e.g. the URL or path that was not found (already redacted). */
  readonly resource: string;
  constructor(message: string, resource: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.resource = resource;
  }
}

export class AuthError extends SourceError {
  readonly kind = 'AuthError' as const;
  readonly retryable = false as const;
  /** true if a token exists but is rejected; false if no token was provided. */
  readonly tokenPresent: boolean;
  constructor(message: string, tokenPresent: boolean, opts?: { cause?: unknown }) {
    super(message, opts);
    this.tokenPresent = tokenPresent;
  }
}

export class RateLimitError extends SourceError {
  readonly kind = 'RateLimitError' as const;
  readonly retryable = true as const;
  /** Unix epoch ms when the rate limit resets; undefined if not available. */
  readonly resetAt?: number;
  constructor(message: string, resetAt?: number, opts?: { cause?: unknown }) {
    super(message, opts);
    this.resetAt = resetAt;
  }
}

/**
 * Local I/O failure that is NOT a transient network condition (EACCES, EIO,
 * EPERM, EBUSY on a local volume, etc.). Distinct from NetworkError so that
 * the consumer's retry policy does not loop on a permission / hardware fault.
 */
export class IoError extends SourceError {
  readonly kind = 'IoError' as const;
  readonly retryable = false as const;
  /** Underlying errno code if available (e.g. 'EACCES', 'EIO'). */
  readonly code?: string;
  constructor(message: string, code?: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.code = code;
  }
}

export class InvalidResponseError extends SourceError {
  readonly kind = 'InvalidResponseError' as const;
  readonly retryable = false as const;
  /** HTTP status code, if applicable. */
  readonly statusCode?: number;
  constructor(message: string, statusCode?: number, opts?: { cause?: unknown }) {
    super(message, opts);
    this.statusCode = statusCode;
  }
}

/**
 * Type-guard. Replaces the older `isSourceError`/`throwSourceError` helpers,
 * which leaked an out-of-band `sourceError` property on a generic Error.
 */
export function isSourceError(e: unknown): e is SourceError {
  return e instanceof SourceError;
}
```

### 2.2. The `PackageSource` interface

```ts
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
   * them. The caller is responsible for sha256 verification after streaming
   * (per §4.6 T4).
   *
   * Synchronous-throw contract: `fetchPayload` itself returns synchronously.
   * Argument-validation failures (path-traversal in `appId`/`version`,
   * `range.start >= range.end`, etc.) MAY throw at the call site as a
   * `SourceError` subclass. All I/O failures (connection refused, 404, hash
   * tag check, EACCES on a share, abort) surface from the FIRST `next()`
   * call of the iterator, never from the function call itself. This is
   * intentional so a caller can `try { iter = source.fetchPayload(...) }`
   * to validate args, then start the actual stream inside `for await`.
   *
   * @param opts.range  If provided, fetch only [start, end) bytes (for resume).
   *                    Implementations that do not support Range MUST throw
   *                    an InvalidResponseError from the first iteration rather
   *                    than silently ignoring.
   * @param opts.signal  AbortSignal for cancellation. On abort, the iterator's
   *                    cleanup MUST delete any `.partial` file (§4.6 T7).
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
```

### 2.3. Design rationale

- `fetchPayload` returns `AsyncIterable<Uint8Array>` rather than `Promise<Uint8Array>` so that large payloads are never fully buffered in the main process. The engine pipes chunks to disk.
- `fetchAsset` returns `Promise<Uint8Array>` because assets (icons, EULAs) are small and uniform buffering is fine.
- `listVersions` is optional (`?`) so `LocalFsSource` and `HttpMirrorSource` can omit it if the directory layout does not support version enumeration without an index file.
- The interface carries no concept of "current channel" — callers pass channel as a hint to `listVersions` only.
- Error handling uses throw (not `Result<T,E>`) at the source boundary because source errors are exceptional, not flow-control values. The engine's own `Result<T,E>` type is used above the source call sites.

---

## 3. Three Implementations (Interface Sketch — Implementation in Phase 2)

These sections define the constructor signature, config shape, and behavioral contract for each implementation. Code bodies are deferred to Phase 2.

**TLS vs signature integrity (NORMATIVE).** None of the network sources rely on TLS for content integrity. TLS provides only (a) confidentiality on the wire and (b) server-identity authentication against the OS trust store. **The signature scheme described in §4.6 is the SOLE integrity guarantee.** This is a deliberate consequence of supporting corporate proxies with custom CA bundles (per main design §6.5): a corporate MITM proxy may legitimately decrypt and re-encrypt traffic, so any catalog/manifest tampering must be caught by the Ed25519 signature, not by TLS. Implementations MUST NOT rely on TLS-level integrity checks (e.g. certificate pinning) as a substitute for signature verification.

### 3.1. `GitHubReleasesSource`

**File:** `src/main/source/github-releases-source.ts`

```ts
export interface GitHubReleasesConfig {
  /**
   * Owner/repo for the catalog. Default: "samsung/vdx-catalog".
   * The catalog release asset is "catalog.json" + "catalog.json.sig" on
   * the release tag named by `ref`.
   */
  catalogRepo: string;

  /**
   * Owner/repo for self-update releases. Default: "samsung/vdx-installer".
   */
  selfUpdateRepo: string;

  /**
   * GitHub organization or owner prefix for app repos.
   *
   * Default inference rule:
   *   appRepo = `${appsOrg}/${slugify(appId.split('.').at(-1)!)}`
   * where slugify lowercases and matches the result against
   * `^[a-z0-9][a-z0-9._-]{0,99}$`. If the slug fails that check, no inferred
   * repo name is produced and the catalog MUST supply an explicit override.
   *
   * Override mechanism: each catalog entry MAY contain an explicit `repo`
   * field of the form `"owner/name"`. When present, the override is used
   * verbatim (no slugification). The catalog schema lives in the data-model
   * spec; this spec only defines how `GitHubReleasesSource` consumes it.
   *
   * Inferred repos that 404 produce a `NotFoundError`; the operator should
   * either rename the GitHub repo to match, or set the catalog override.
   */
  appsOrg: string;

  /**
   * GitHub REST API base URL. Default: "https://api.github.com".
   * Override for GitHub Enterprise Server: "https://github.example.com/api/v3".
   */
  apiBase: string;

  /**
   * Release tag used to locate the catalog assets.
   * Default: "stable". The catalog repo must have a release with this tag.
   */
  ref: string;
}

/**
 * Reads a GitHub PAT from the system keychain via keytar.
 * PAT is optional — falls back to unauthenticated (60 req/h rate limit).
 * PAT must have `contents:read` scope for the target repos.
 * AuthError is thrown when a token is present but rejected (401).
 * RateLimitError is thrown on 403 with X-RateLimit-Remaining: 0.
 */
export declare class GitHubReleasesSource implements PackageSource {
  readonly id: 'github';
  readonly displayName: string;
  constructor(config: GitHubReleasesConfig, keytarService?: string);
}
```

**URL layout (GitHub Releases API):**

| Resource | API call |
|---|---|
| Catalog | `GET ${apiBase}/repos/${catalogRepo}/releases/tags/${ref}` → find asset `catalog.json` → download URL |
| Catalog sig | Same release → asset `catalog.json.sig` |
| Manifest | `GET ${apiBase}/repos/${appRepo}/releases/tags/v${version}` → asset `manifest.json` |
| Payload | Same release → asset `payload.zip` (streamed with Range support via `Accept-Ranges` header) |
| Asset | Same release → asset by name |
| Versions | `GET ${apiBase}/repos/${appRepo}/releases` (paginated) → filter by channel tag |

**Note on the catalog URL — supersedes main design §4.1.** The main design previously sketched the catalog at `https://raw.githubusercontent.com/samsung/vdx-catalog/main/catalog.json` (a branch-tip raw blob). This spec adopts the **Releases-asset** model instead: catalogs are versioned, atomic, separately-signed assets attached to a tagged release, fetched through `${apiBase}/repos/...`. The Releases model gives us (a) atomic publish (raw blob can be torn during a push), (b) a place to attach the detached `.sig`, (c) a stable URL even if the default branch is renamed, and (d) free CDN caching. Phase 2 implementers MUST NOT keep the raw blob URL as a fallback. The main design's §4.1 is updated alongside Phase 2 work.

**PAT management:**
- Stored in OS keychain via `keytar` under service name `"vdx-installer"`, account `"github-pat"`. (Main design §9.3 previously named the keytar target `"vdx-installer:github"` — the `service: 'vdx-installer'` + `account: 'github-pat'` form here is canonical and supersedes that note. The Phase 2 implementer is responsible for proposing the matching update to the design spec.)
- Required PAT scope: **`contents:read` only**, on specific repositories (not user-wide). Fine-grained PATs are strongly preferred over classic PATs for least-privilege and short-lived credentials. The host MUST log `warn` if the configured PAT cannot read the catalog repo's release assets but reads succeed for unrelated paths (suggests over-broad scope).
- Keychain ACL:
  - **macOS**: the keychain item's access-list MUST be set so only the signed `vdx-installer.app` bundle (matching the host's code-signing identity) can read it without prompt. Other apps under the same user account get an unlock prompt or an error.
  - **Windows**: Credential Manager isolates only per-user, not per-process. The spec acknowledges that same-user malware can read the credential. Mitigation is policy: prefer fine-grained PATs scoped to the catalog/installer repos, with a 90-day max lifetime documented in the operator runbook.
  - **Linux** (when supported): use libsecret with the secret-tool schema's `applicationId` attribute and document the same threat as Windows.
- `keytar`-unavailable fallback: the host MUST refuse to authenticate (no PAT, fall back to unauthenticated access at 60 req/h) and emit `warn`. It MUST NOT silently fall back to reading a PAT from a file or environment variable — that would lower the bar for accidental disclosure.
- Never logged; `redact.ts` strips GitHub tokens of every published shape (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, and fine-grained `github_pat_*`) from any string before writing to log. The redactor uses a single regex covering all prefixes; adding a new prefix is a one-line change.
- If token refresh is needed (OAuth app flow), that is Phase 3+ scope.

**Caching:**
- The `ETag` value from the catalog response is stored alongside the catalog in `%APPDATA%/vdx-installer/cache/catalog/`. (`X-RateLimit-*` headers, when present, are surfaced to telemetry / `RateLimitError` only — they are not cache validators.)
- `If-None-Match` header is sent on subsequent catalog fetches.

### 3.2. `HttpMirrorSource`

**File:** `src/main/source/http-mirror-source.ts`

```ts
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
   * Optional proxy override for this source only (default: system proxy from config).
   */
  proxyUrl?: string;
}

/**
 * URL layout (must be reproduced exactly by mirror operators):
 *
 *   ${baseUrl}/catalog.json
 *   ${baseUrl}/catalog.json.sig
 *   ${baseUrl}/apps/${appId}/${version}/manifest.json
 *   ${baseUrl}/apps/${appId}/${version}/manifest.json.sig
 *   ${baseUrl}/apps/${appId}/${version}/payload.zip
 *   ${baseUrl}/apps/${appId}/${version}/assets/${assetName}
 *
 * listVersions is implemented by fetching a version index file:
 *   ${baseUrl}/apps/${appId}/versions.json   (array of semver strings, newest first)
 *
 * If versions.json is absent, listVersions returns NotFoundError (optional method).
 *
 * HTTP Range support: MUST honour Range requests on payload.zip.
 * ETag support: SHOULD return ETag on catalog.json; MUST honour If-None-Match.
 */
export declare class HttpMirrorSource implements PackageSource {
  readonly id: 'http-mirror';
  readonly displayName: string;
  constructor(config: HttpMirrorConfig);
}
```

**Behavioral contract:**
- All requests use `undici` (same HTTP client as the rest of the app).
- Retries: 3 attempts max.
  - `NetworkError`: exponential backoff (250 ms → 500 ms → 1 s, ±20 % jitter).
  - `RateLimitError`: wait until `resetAt` if known (capped at 60 s); otherwise fall back to exponential backoff. Retrying before `resetAt` would just hit 429 again, so the resetAt value is preferred over a generic backoff.
- Timeout: configurable per-request; default 30 s for manifests/assets, no global timeout for payload stream (the engine controls this via AbortSignal).
- HTTP 404 → `NotFoundError`.
- HTTP 401 → `AuthError(tokenPresent: <token configured?>)`.
- HTTP 403 →
  - if `Retry-After` is present, OR `X-RateLimit-Remaining: 0` is present, OR `Retry-After` parses to a future time → `RateLimitError(resetAt)` (mirrors of GitHub-Enterprise-style backends use 403 for rate-limit).
  - otherwise → `AuthError(tokenPresent: <token configured?>)`.
- HTTP 429 → `RateLimitError` with `resetAt` parsed from `Retry-After` (HTTP-date or delta-seconds).
- HTTP 5xx → `NetworkError` (retryable).
- Any non-JSON body where JSON expected → `InvalidResponseError(statusCode)`.

**Proxy precedence (NORMATIVE):**

When constructing a request, the proxy is selected by the first matching rule:

1. `HttpMirrorConfig.proxyUrl` is set on this source → use it (per-source override).
2. `vdx.config.json`'s top-level `proxy.kind === 'explicit'` → use `proxy.url`.
3. `proxy.kind === 'none'` → bypass all proxies (direct connect).
4. `proxy.kind === 'system'` (or `proxy` field absent) → resolve via OS proxy settings at connect time.

`HttpMirrorConfig.proxyUrl` and `proxy.url` MUST use the `https://` or `socks5://` scheme. Plain `http://` proxies are rejected with `ConfigError` because credentials and auth headers would be visible in cleartext to the proxy operator regardless of the upstream TLS — this is enforced at config-load time, not request time.

### 3.3. `LocalFsSource`

**File:** `src/main/source/local-fs-source.ts`

```ts
export interface LocalFsConfig {
  /**
   * Root directory of the local mirror.
   * Example: "C:/Program Files/Samsung/VDX-Mirror"
   * Example (network share): "//corp.example.com/vdx-mirror"
   *
   * Directory layout mirrors HttpMirrorSource URL layout with slashes as separators:
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
   *
   * The type is the narrow subset of `node:fs/promises` that LocalFsSource
   * actually calls. Using a structural subset avoids forcing memfs (which
   * does not implement the entire fs/promises surface, e.g. `glob`, `cp`)
   * to require a TS cast at every test call site.
   */
  fs?: LocalFsApi;
}

/** Methods of `node:fs/promises` that `LocalFsSource` calls. */
export interface LocalFsApi {
  access(path: string): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ size: number; mtimeMs: number }>;
  open(path: string, flags: string): Promise<LocalFsHandle>;
}

export interface LocalFsHandle {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

/**
 * LocalFsSource is the canonical source for all engine tests.
 * It is the ONLY source available in Phase 1.0.
 * It is feature-flagged off in production until Phase 2.
 *
 * listVersions reads apps/${appId}/versions.json if present; otherwise
 * scans subdirectory names in apps/${appId}/ and returns semver-sorted results.
 */
export declare class LocalFsSource implements PackageSource {
  readonly id: 'local-fs';
  readonly displayName: string;
  constructor(config: LocalFsConfig);
}
```

**Behavioral contract — fs error mapping:**

| Errno | `SourceError` kind | retryable | Rationale |
|---|---|---|---|
| `ENOENT` | `NotFoundError` | false | File missing — callers handle as not-yet-published. |
| `EACCES` / `EPERM` | `AuthError(tokenPresent: false)` | false | Permission denied — retrying never helps and can mask a deliberate access change. |
| `EIO` | `InvalidResponseError` | false | Disk/share corruption — fail fast so the caller surfaces a real fault. |
| `ENOTDIR` / `ELOOP` | `InvalidResponseError` | false | Path shape is wrong — a retry cannot fix it. |
| `ENOTCONN` / `EHOSTUNREACH` / `ENETUNREACH` / `ETIMEDOUT` | `NetworkError` | true | UNC share disconnects — retry policy applies. |
| `EBUSY` / `EAGAIN` | `IoError(code)` | false | Resource lock — surface to user; do not silently retry. |
| Anything else | `IoError(code)` | false | Unknown errno — fail closed; never auto-retry on an error we don't classify. |

- `fetchPayload` with `range` uses `fs.open` + `read` to seek to `range.start` and yield only the requested bytes.
- ETag: computed as `"${mtimeMs}-${size}"` on catalog.json; stored and compared to detect catalog freshness.
- Atomic visibility: on network shares, partial writes by the publisher may result in a torn file. `LocalFsSource` does not have an out-of-band size hint to compare against (`versions.json` carries semver strings only — see §3.2). The contract is therefore: **callers must verify sha256 after every payload fetch** (which they already do per the `PackageSource` contract in §2.2), and catalog/manifest readers must verify the Ed25519 signature; a torn file fails one of these checks and surfaces as `InvalidResponseError`. Publishers SHOULD write to a temp file and rename atomically; this is documented as an operator guideline rather than enforced by `LocalFsSource`.

---

## 4. `vdx.config.json` Schema

### 4.1. File location & precedence

The host searches for `vdx.config.json` in this order, using the **first file found** (highest precedence first):

1. **Next-to-EXE**: same directory as `vdx-installer.exe`. Highest precedence — supports IT pre-configured installs that override any user-level config.
2. **APPDATA**: `%APPDATA%\vdx-installer\vdx.config.json`. Used when no Next-to-EXE config is present; lets a user override the built-in defaults.
3. **Built-in defaults**: hardcoded in `src/main/source/config-defaults.ts` (GitHub source with standard repos).

Rule: the first file found wins entirely. There is no deep-merge across locations. This is intentional — an IT administrator placing a config next to the EXE knows exactly what they are overriding.

**Both-locations probe:** the loader does **not** stop at first match for diagnostic purposes. It probes every candidate path with `fs.access` (or equivalent) before returning, so it can emit a `warn`-level log entry when more than one candidate exists, listing which path was loaded and which were shadowed. Only the highest-precedence file's contents are parsed and validated; lower-precedence files are not read.

**Reload semantics:** Config is read once at application startup. Changes to `vdx.config.json` take effect only after the application is restarted. There is no hot-reload.

### 4.2. JSON schema

A real `vdx.config.json` populates **exactly one** of `github`, `httpMirror`, or `localFs` — the one matching `source.type`. The zod schema in §4.3 rejects an object that includes a non-matching backend block. The three blocks are shown together below for documentation purposes only; copy only the block that matches your chosen `type`.

```jsonc
// vdx.config.json — schemaVersion 1
// Documentation form: shows all three backends. A real file uses exactly one.
{
  // Must be present and equal to 1 for this spec version.
  "schemaVersion": 1,

  // Which source backend to use. Exactly one of the backend-specific
  // blocks must be populated (matching the "type" value).
  "source": {
    "type": "github",   // or "http-mirror" or "local-fs"

    // Include this block ONLY when type == "github"
    "github": {
      "catalogRepo": "samsung/vdx-catalog",
      "selfUpdateRepo": "samsung/vdx-installer",
      "appsOrg": "samsung",
      "apiBase": "https://api.github.com",
      "ref": "stable"
    }

    // -- OR -- include this block ONLY when type == "http-mirror"
    // "httpMirror": {
    //   "baseUrl": "https://vdx.example.com"
    // }

    // -- OR -- include this block ONLY when type == "local-fs"
    // "localFs": {
    //   "rootPath": "C:/Program Files/Samsung/VDX-Mirror"
    // }
  },

  // Ed25519 public keys trusted to sign catalogs and manifests.
  // Each entry is a base64-encoded 32-byte Ed25519 public key.
  // STRICTLY ADDITIVE: the embedded key compiled into the host binary is
  // ALWAYS trusted; trustRoots only adds keys to that set. A config can never
  // remove or weaken the embedded trust anchor. See §4.6 for the normative rule.
  // Cap: ≤ 16 entries.
  "trustRoots": [
    "base64-encoded-32-byte-ed25519-pubkey-1",
    "base64-encoded-32-byte-ed25519-pubkey-2"
  ],

  // Default channel for catalog browsing. App-level override via catalog entry.
  "channel": "stable",   // or "beta" or "internal"

  // HTTP proxy configuration. Exactly one shape; `kind` is the discriminator.
  // Use ONE of:
  //   { "kind": "system" }                                          // OS proxy settings
  //   { "kind": "none" }                                            // bypass all proxies
  //   { "kind": "explicit", "url": "http://proxy.corp.example.com:8080" }
  "proxy": { "kind": "system" },

  // Disable telemetry entirely (overrides user setting).
  "telemetry": false,

  // Developer mode policy override (operator-level, not user-level).
  //
  // This is a policy ceiling, not the user-toggleable setting. The main
  // design spec defines a per-user `developerMode` field in
  // `installed.json.settings` (toggleable from Settings UI). The two
  // interact as follows:
  //
  //   effective = policy_developerMode AND user_developerMode
  //
  // i.e. the policy MUST permit it, AND the user MUST also opt in. A config
  // with `"developerMode": true` raises the ceiling but does not turn on
  // unsigned-install behaviour by itself; the user still has to flip the
  // Settings toggle. A config with `"developerMode": false` (the default)
  // forces the user toggle to read-only off.
  //
  // §4.6 T8 additionally requires a debug-build product code OR
  // VDX_DEV_MODE=1 in env for the policy ceiling to take effect at all on a
  // production-signed binary.
  "developerMode": false
}
```

### 4.3. Zod schema

**File:** `src/shared/source/config-schema.ts`

```ts
import { z } from 'zod';

// IMPORTANT: this module is in `src/shared/` and must remain importable from
// the Electron renderer (which runs with contextIsolation + sandbox and has
// no Node built-ins). Do NOT import from 'node:*' here. Path-shape checks
// are implemented as regex; main-process semantic validation (e.g. fs.access
// on rootPath) lives next to the source classes in `src/main/source/`.

// Strict canonical base64 for a 32-byte Ed25519 public key.
// 32 bytes → 44 chars (43 base64 chars + 1 padding `=`). The trailing pad slot
// only allows certain characters in canonical form, and Buffer.from is lenient,
// so we verify both the regex shape AND that the value round-trips back to the
// same string after decode/encode (defeats non-canonical encodings).
const STRICT_BASE64_44 = /^[A-Za-z0-9+/]{43}=$/;

const Base64PubKey = z
  .string()
  .refine(
    (s) => {
      if (!STRICT_BASE64_44.test(s)) return false;
      const buf = Buffer.from(s, 'base64');
      if (buf.length !== 32) return false;
      return buf.toString('base64') === s; // canonical round-trip check
    },
    { message: 'trustRoots entry must be a canonical base64-encoded 32-byte Ed25519 public key' },
  );

// Path-shape check that does not require node:path. Accepts:
//   - POSIX absolute: starts with "/"
//   - Windows drive-absolute: "C:\..." or "C:/..."
//   - UNC: "\\server\share\..." or "//server/share/..."
const ABSOLUTE_PATH_RE =
  /^(?:\/(?!\/)|[A-Za-z]:[\\/]|[/\\]{2}[^/\\]+[/\\][^/\\]+)/;

const GitHubSourceConfig = z.object({
  catalogRepo: z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i),
  selfUpdateRepo: z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i),
  appsOrg: z.string().min(1),
  apiBase: z.string().url(),
  ref: z.string().min(1),
});

const HttpMirrorSourceConfig = z.object({
  baseUrl: z.string().url(),
  token: z.string().optional(),
  proxyUrl: z.string().url().optional(),
});

const LocalFsSourceConfig = z.object({
  // rootPath must be absolute. Shape-only regex check at the schema layer;
  // existence and accessibility of the directory are verified at LocalFsSource
  // construction time in the main process.
  rootPath: z
    .string()
    .min(1)
    .max(32_767) // Windows MAX_PATH-with-prefix ceiling; arbitrary but bounded
    .refine(
      (p) => ABSOLUTE_PATH_RE.test(p),
      { message: 'rootPath must be absolute (e.g. "C:/path", "/path", or "//server/share/...")' },
    ),
});

const SourceConfig = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('github'),
    github: GitHubSourceConfig,
    httpMirror: z.undefined().optional(),
    localFs: z.undefined().optional(),
  }),
  z.object({
    type: z.literal('http-mirror'),
    httpMirror: HttpMirrorSourceConfig,
    github: z.undefined().optional(),
    localFs: z.undefined().optional(),
  }),
  z.object({
    type: z.literal('local-fs'),
    localFs: LocalFsSourceConfig,
    github: z.undefined().optional(),
    httpMirror: z.undefined().optional(),
  }),
]);

const ProxyConfig = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('system') }),
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('explicit'), url: z.string().url() }),
]);

export const VdxConfigSchema = z.object({
  schemaVersion: z.literal(1),
  source: SourceConfig,
  trustRoots: z.array(Base64PubKey).max(16).optional(),
  channel: z.enum(['stable', 'beta', 'internal']).default('stable'),
  proxy: ProxyConfig.optional(),
  telemetry: z.boolean().default(true),
  developerMode: z.boolean().default(false),
});

export type VdxConfig = z.infer<typeof VdxConfigSchema>;
```

### 4.4. Validation rules

| Rule | Behaviour on failure |
|---|---|
| `schemaVersion` not 1 | Hard fail: `loadConfig` throws `ConfigError` with message; app refuses to start. |
| `source.type` is `"github"` but `source.github` is missing, or a non-matching block (`httpMirror`, `localFs`) is also populated | Zod discriminated union rejects; `ConfigError`. Same logic applies for `"http-mirror"` and `"local-fs"`. |
| `trustRoots` entry is not a valid base64 32-byte key | `ConfigError`. |
| `source.localFs.rootPath` is a relative path | `ConfigError` (must be absolute for determinism). |
| `developerMode: true` | Load succeeds; engine emits a `warn` log and shows a persistent UI banner. |
| Config file exists but is not valid JSON | `ConfigError`: "Failed to parse vdx.config.json: {SyntaxError message}". Do NOT silently fall through to next location. |
| Config file exists but fails zod validation | `ConfigError`: "Invalid vdx.config.json: {zod format errors}". Same — hard fail. |

The philosophy: a corrupt config that is silently ignored is worse than an app that refuses to start with a clear error. IT operators and developers must see config errors loudly.

### 4.5. Redaction rules for logs

Before writing any config field to a log file:

| Field | Redaction |
|---|---|
| `source.github.apiBase` | Log as-is (not secret). |
| `source.httpMirror.token` | Replace with `[REDACTED:TOKEN]`. |
| `source.httpMirror.proxyUrl` | Strip credentials from URL before logging (same `//user:pass@` regex as `proxy.url`). |
| `source.localFs.rootPath` | Replace the home-directory prefix with `~/...`: `C:\Users\<username>\...` (Windows), `/Users/<username>/...` (macOS), `/home/<username>/...` (Linux), and the value of `os.homedir()` at runtime. Implemented in `redact.ts`. |
| `trustRoots[*]` | Log only first 8 chars of each entry, suffix `...` (fingerprint, not full key). |
| `proxy.url` | Strip credentials from URL before logging (regex on `//user:pass@` pattern). |

Redaction MUST happen at error-construction time (in the `SourceError` factory), not only at log-write time, because errors are serialised through IPC, telemetry, and crash reports — many of which never go through the logger. The redactor regex set is the union of: every `redact.ts` rule listed above, `Bearer\s+\S+`, `[?&](token|key|access_token|api_key)=[^&]+`, and `Basic\s+[A-Za-z0-9+/=]+`.

### 4.6. Security invariants (NORMATIVE)

These rules are **MUST** for every implementation and consumer of `PackageSource`. They consolidate protections that previously lived only in the §9 risks table.

**T1. Trust-root union.** The effective trust root set is the **union** of the embedded Ed25519 public key (compiled into the host binary) and any `trustRoots` entries from `vdx.config.json`. The embedded key is always trusted and cannot be removed, disabled, or shadowed by config. Engine signature verification accepts a signature if it validates against ANY key in the union. A config supplying `trustRoots: []` does NOT degrade trust to "no keys"; it leaves the embedded key in place.

**T2. End-to-end trust chain.** A successful install MUST verify, in this order:
1. `catalog.json.sig` validates against the trust-root union over the bytes of `catalog.json`.
2. The catalog entry for `(appId, version)` includes `manifestSha256`. After `fetchManifest`, the consumer MUST verify `sha256(manifestBytes) === manifestSha256` BEFORE trusting any field of the manifest.
3. `manifest.json.sig` validates against the trust-root union over the bytes of `manifest.json` (defence-in-depth alongside T2.2).
4. The manifest's `payload.sha256` and `payload.size` are signature-covered fields. After `fetchPayload` completes, the consumer MUST verify `sha256(writtenBytes) === payload.sha256` and `writtenBytes.length === payload.size`.

If the catalog format does not yet carry `manifestSha256`, that field is added in Phase 2 alongside this spec; until then, T2.2 is a hard MUST for the catalog producer to satisfy and for the consumer to enforce. The consumer MUST refuse to install when the field is missing.

**T3. Path-component validation.** Every `appId`, `version`, and `assetName` value passed to a `PackageSource` method MUST be validated by the source before path/URL construction:
- `appId`: matches `^[a-z0-9][a-z0-9._-]{0,127}$` (reverse-DNS, lowercase, no `..`, no path separators).
- `version`: strict semver per `^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`.
- `assetName`: matches `^[A-Za-z0-9._-][A-Za-z0-9._/-]{0,255}$`, MUST NOT contain `..`, MUST NOT begin with `/` or `\`, and after path normalisation MUST resolve inside the source's root (for `LocalFsSource`: `path.resolve(rootPath, assetName)` starts with `path.resolve(rootPath) + sep`; for `HttpMirrorSource`: percent-encoded segments only, no CRLF).

A failed check throws `InvalidResponseError` with `statusCode: undefined` and a generic message; the offending value MUST NOT be echoed verbatim in the error to keep log-lines safe to render.

**T4. Streaming integrity binding.** For `fetchPayload`:
- The hash MUST be computed over the **complete concatenated file as written to disk**, not over per-request slices. Resuming with `Range: bytes=N-` does not exempt the prefix from rehashing.
- Implementations MUST track total bytes received against `manifest.payload.size` and throw `InvalidResponseError` if the response would exceed it.
- On hash mismatch the `.partial` file MUST be deleted before any retry.

**T5. Size caps.** Implementations MUST enforce hard maxima and throw `InvalidResponseError` on overrun:

| Resource | Cap |
|---|---|
| `catalog.json` (+ sig) | 4 MiB (256 B) |
| `manifest.json` (+ sig) | 1 MiB (256 B) |
| `versions.json` | 256 KiB |
| Asset (`fetchAsset`) | 8 MiB |
| `payload.zip` | min(declared `manifest.payload.size`, 4 GiB global ceiling) |
| `fetchPayload` chunk | 1 MiB per yielded `Uint8Array` |

**T6. Freshness / rollback protection.** Catalog and manifest MUST carry, inside the signed envelope, a strictly-monotonic `sequence: number` and an RFC-3339 `generatedAt` timestamp. The host stores the highest `sequence` ever observed per resource (catalog, per-app manifest) in `%APPDATA%/vdx-installer/state/freshness.json`. On fetch:
- If observed `sequence < stored sequence` → `InvalidResponseError("rollback detected")`.
- If `now() - generatedAt > 30 days` → fail closed for fresh installs; existing installations may continue to use the cached value with a UI warning, but updates are blocked until a fresh signed catalog is observed.

**T7. Cancellation cleanup.** When `fetchPayload`'s caller aborts (via `AbortSignal`, exception, or process exit on a best-effort basis), the implementation MUST delete the `.partial` file before propagating the abort. A startup reaper deletes any `.partial` file older than 24 h. Total cache directory size is capped at 4 GiB with LRU eviction.

**T8. `developerMode` hard gate.** Setting `developerMode: true` in `vdx.config.json` is necessary but NOT sufficient. The host honours the flag only when at least one of the following is also true:
- The binary is a debug build (separate product code, internal codesign certificate, distinct app icon).
- The launching process has `VDX_DEV_MODE=1` in its environment.

A production-distributed binary that observes `developerMode: true` without one of the above MUST refuse to start with `ConfigError("developerMode requires a debug build or VDX_DEV_MODE=1")`. The UI banner and `warn` log are kept as defence-in-depth, not as the primary control.

**T9. Per-user vs admin config scope.** When `vdx.config.json` is loaded from `%APPDATA%` (per-user, not admin-elevated), the loader MUST ignore the following fields and emit a `warn` for each one ignored: `trustRoots`, `developerMode`, `source.github.apiBase` (overriding the API base is a trust-shifting change). These fields are honoured only when the config is read from the next-to-EXE location (admin-write on `%ProgramFiles%`). Per-user configs may freely set `proxy`, `channel`, `telemetry`, and `source.type/baseUrl/rootPath` for non-trust-shifting use cases.

**T10. APPDATA fallback safety.** If `process.env['APPDATA']` is unset and the loader falls back to `os.homedir()`, the resolved candidate path MUST start with `os.homedir()`. An empty-string fallback that resolves to `./vdx-installer/...` (CWD-relative) MUST be rejected with `ConfigError`.

---

## 5. Engine Integration (Phase 1.0 Implications)

### 5.1. Core principle

The Phase 1.0 engine operates exclusively on data that has already been fetched and placed on disk or in memory. It has no knowledge of `"github"`, `api.github.com`, or any network URL.

Concretely: every engine function that consumes a manifest or payload accepts **either**:
- A `Buffer` / `Uint8Array` (already-fetched bytes), or
- A `PackageSource` instance + coordinates (appId + version) via dependency injection.

The `PackageSource` dependency injection point is the **engine façade** (`src/main/engine.ts` — renamed from `src/main/index.ts` in Phase 1.1), not the inner engine functions. Inner functions (`runInstall`, `runUninstall`, `validateManifestSemantics`, etc.) never see a `PackageSource`.

### 5.1.1. `installed.json.source` enum extension (NORMATIVE)

The main design defines `installed.json.source ∈ {'catalog', 'sideload'}`. To distinguish installs sourced from a `LocalFsSource` mirror (a non-network "catalog" via the abstraction defined here) from network catalog installs, Phase 2 extends this enum:

| Value | Meaning |
|---|---|
| `'sideload'` | User dropped a `.vdxpkg` directly. Bypasses the source abstraction entirely. |
| `'catalog'` | Installed via the `PackageSource` abstraction over the active source backend. Implementations record the backend in a separate `installed.json.sourceBackend` field: `'github' \| 'http-mirror' \| 'local-fs'` (matching `PackageSource.id`). |

Adding `sourceBackend` is additive (new optional field on existing entries; older entries default to `null` and the host displays "unknown" in Settings → About). This avoids a hard schema migration while preserving the `'catalog' | 'sideload'` distinction used throughout the design spec.

### 5.2. Engine surface that depends on this abstraction

The following components are the **only** engine-layer touch points for source-aware behavior:

| Component | Interaction with source |
|---|---|
| `src/main/engine/install.ts` | Accepts pre-fetched `payloadBytes: Buffer`. Knows nothing about where bytes came from. |
| `src/main/packages/vdxpkg.ts` | Accepts pre-fetched `vdxpkgBytes: Buffer`. Same. |
| `src/main/packages/signature.ts` | Accepts raw `message` + `signature` bytes. Same. |
| `src/main/source/catalog-sync.ts` (Phase 2) | The ONE component that calls `PackageSource.fetchCatalog`. Validates sig, stores to cache. |
| `src/main/source/manifest-fetcher.ts` (Phase 2) | Calls `PackageSource.fetchManifest`. Validates sig. |
| `src/main/source/payload-downloader.ts` (Phase 2) | Calls `PackageSource.fetchPayload`. Streams to `.partial` file, then verifies sha256 and renames. |

In Phase 1.0 the three Phase 2 coordinator components do not yet exist; the engine consumes pre-fetched bytes from the sideload flow. When they arrive in Phase 2 they will be wired exclusively to `LocalFsSource` until the source feature flag flips (see §8).

### 5.3. Dependency injection pattern

```ts
// src/main/engine/install.ts — current signature (Phase 1.0)
export interface InstallInput {
  manifest: Manifest;
  payloadBytes: Buffer;           // pre-fetched; engine does not call source
  wizardAnswers: Record<string, unknown>;
  platform: Platform;
  runner: TransactionRunner;
  hostExePath: string;
  scope?: 'user' | 'machine';
}

// src/main/source/install-coordinator.ts — Phase 2 addition
// This is the integration layer between source and engine.
export interface InstallCoordinatorInput {
  source: PackageSource;         // injected
  appId: string;
  version: string;
  wizardAnswers: Record<string, unknown>;
  platform: Platform;
  runner: TransactionRunner;
  installedStore: InstalledStore;
  trustRoots: Uint8Array[];      // from config
  hostExePath: string;
  scope?: 'user' | 'machine';
  signal?: AbortSignal;
}
```

The `InstallCoordinator` (Phase 2) calls `source.fetchManifest`, verifies signature with `verifySignature`, calls `source.fetchPayload` + streams to cache, then calls `runInstall` with the pre-fetched buffer. The engine itself remains source-agnostic.

### 5.4. Resolver tests

Phase 1.0 engine unit tests stay source-agnostic: they pass `payloadBytes: Buffer` directly to `runInstall`, exactly as today (see §7.1). Once the Phase 2 coordinator components land, an end-to-end integration test exercises the full path from manifest fetch through install by constructing a `LocalFsSource` over `memfs`. The fixture below is therefore a **Phase 2 addition**, not a Phase 1.0 test:

```ts
// In test/engine/install-e2e.test.ts (Phase 2 addition)
const source = new LocalFsSource({
  rootPath: 'test/fixtures/mirror',
  fs: memfsInstance.promises,
});
// Populate memfs with the test manifest + payload...
const manifest = await source.fetchManifest('com.samsung.vdx.test', '1.0.0');
// ...verify, then pass buffer to runInstall
```

---

## 6. Runtime Resolution & Config Loader

**File:** `src/main/source/load-config.ts`

### 6.1. Pseudocode

```ts
/**
 * loadConfig — locate, parse, and validate vdx.config.json.
 *
 * Call once at startup. The result is immutable for the process lifetime.
 * Never call during install/uninstall operations.
 *
 * @param exeDir  Absolute path to the directory containing vdx-installer.exe.
 *                Pass null in tests (skips next-to-EXE search).
 */
export async function loadConfig(exeDir: string | null): Promise<VdxConfig> {
  // 1. Build the search list in precedence order.
  // Each candidate is tagged with its trust scope so §4.6 T9 / T10 can be
  // applied after parsing.
  const candidates: { path: string; scope: 'next-to-exe' | 'appdata' }[] = [];
  if (exeDir !== null) {
    candidates.push({
      path: path.join(exeDir, 'vdx.config.json'),
      scope: 'next-to-exe',
    });
  }
  const home = os.homedir(); // cross-platform; never returns ""
  const appData = process.env['APPDATA'] ?? home;
  // T10 — refuse a candidate path that does not start with home/APPDATA.
  // Guards against process.env corruption that could resolve to CWD-relative.
  const appDataResolved = path.resolve(appData, 'vdx-installer', 'vdx.config.json');
  if (
    appDataResolved.startsWith(path.resolve(home)) ||
    (process.env['APPDATA'] && appDataResolved.startsWith(path.resolve(process.env['APPDATA'])))
  ) {
    candidates.push({ path: appDataResolved, scope: 'appdata' });
  } else {
    logger.warn('source.config.appdata-rejected', { resolved: appDataResolved });
  }

  // 2. Walk candidates in precedence order. On the first successful read,
  //    log a shadow-warn for any lower-precedence candidate that also exists.
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    let raw: string;
    try {
      raw = await fs.readFile(c.path, 'utf-8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new ConfigError(`Cannot read ${c.path}: ${(e as Error).message}`);
    }

    // 2a. Detect shadowed lower-precedence configs.
    const shadowed: string[] = [];
    for (const other of candidates.slice(i + 1)) {
      try {
        await fs.access(other.path);
        shadowed.push(other.path);
      } catch { /* not present */ }
    }
    if (shadowed.length > 0) {
      logger.warn('source.config.shadowed', { loaded: c.path, shadowed });
    }

    // 3. Parse JSON — hard fail on syntax error.
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      throw new ConfigError(`Failed to parse ${c.path}: ${(e as Error).message}`);
    }

    // 4. Validate schema — hard fail on invalid.
    const result = VdxConfigSchema.safeParse(obj);
    if (!result.success) {
      throw new ConfigError(
        `Invalid vdx.config.json at ${c.path}:\n` +
        result.error.errors.map((e) => `  ${e.path.join('.')}: ${e.message}`).join('\n'),
      );
    }

    // 5. T9 — strip trust-shifting fields when the config is per-user.
    let cfg = result.data;
    if (c.scope === 'appdata') {
      cfg = stripTrustShiftingFields(cfg, (field) =>
        logger.warn('source.config.field-ignored-appdata', { field, path: c.path }),
      );
    }

    logger.info('source.config.loaded', {
      path: c.path,
      scope: c.scope,
      sourceType: cfg.source.type,
    });
    return cfg;
  }

  // 6. No config file found — return hardcoded defaults.
  logger.info('source.config.using-defaults');
  return VdxConfigSchema.parse(CONFIG_DEFAULTS);
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Per §4.6 T9: per-user (APPDATA) configs may not silently change the
 * trust posture. Drop trust-shifting fields before returning the config.
 */
function stripTrustShiftingFields(
  cfg: VdxConfig,
  onIgnored: (field: string) => void,
): VdxConfig {
  const next: VdxConfig = structuredClone(cfg);
  if (next.trustRoots !== undefined) {
    onIgnored('trustRoots');
    delete (next as Partial<VdxConfig>).trustRoots;
  }
  if (next.developerMode === true) {
    onIgnored('developerMode');
    next.developerMode = false;
  }
  if (next.source.type === 'github' && 'github' in next.source && next.source.github) {
    if (next.source.github.apiBase !== CONFIG_DEFAULTS.source.github.apiBase) {
      onIgnored('source.github.apiBase');
      next.source.github.apiBase = CONFIG_DEFAULTS.source.github.apiBase;
    }
  }
  return next;
}
```

### 6.2. Built-in defaults

**File:** `src/main/source/config-defaults.ts`

```ts
// These are the ONLY place in the codebase where "samsung/vdx-catalog" and
// related strings appear. All other code reads from the loaded VdxConfig.
//
// Only fields whose values cannot come from a zod .default() live here.
// `channel`, `telemetry`, `developerMode` are filled in by the schema's
// .default() clauses when this object is parsed via VdxConfigSchema.parse().
export const CONFIG_DEFAULTS = {
  schemaVersion: 1 as const,
  source: {
    type: 'github' as const,
    github: {
      catalogRepo: 'samsung/vdx-catalog',
      selfUpdateRepo: 'samsung/vdx-installer',
      appsOrg: 'samsung',
      apiBase: 'https://api.github.com',
      ref: 'stable',
    },
  },
};
```

**Enforcement rule for reviewers (CODE-only, not docs).** Run `grep -rn --include='*.ts' --include='*.tsx' "samsung/vdx-catalog\|api.github.com\|samsung/vdx-installer" src/` as part of the PR checklist. The only allowed match in `src/` is `src/main/source/config-defaults.ts`. Any other match in source code is a blocking defect.

The rule does NOT apply to:
- Documentation under `docs/` (the main design uses these strings as working placeholders).
- Tests under `test/` that reference the defaults to verify the source-resolution path.
- `package.json` and CI configuration (which legitimately reference the installer's own repo for self-update).

### 6.3. `createSource` factory

**File:** `src/main/source/create-source.ts`

```ts
import type { VdxConfig } from '@shared/source/config-schema';
import type { PackageSource } from '@shared/source/package-source';

/**
 * Instantiate the PackageSource described by the loaded config.
 * All source constructors are dynamically imported to avoid bundling
 * GitHub/HTTP client code when using LocalFsSource.
 */
export async function createSource(config: VdxConfig): Promise<PackageSource> {
  switch (config.source.type) {
    case 'github': {
      const { GitHubReleasesSource } = await import('./github-releases-source');
      return new GitHubReleasesSource(config.source.github!);
    }
    case 'http-mirror': {
      const { HttpMirrorSource } = await import('./http-mirror-source');
      return new HttpMirrorSource(config.source.httpMirror!);
    }
    case 'local-fs': {
      const { LocalFsSource } = await import('./local-fs-source');
      return new LocalFsSource(config.source.localFs!);
    }
  }
}
```

---

## 7. Testing Strategy

### 7.1. `LocalFsSource` as canonical test implementation

Every engine test that previously supplied raw `payloadBytes: Buffer` directly should continue to do so (engine is source-agnostic). Integration tests that exercise the coordination layer (Phase 2 onward) use `LocalFsSource` backed by `memfs`:

```ts
// test/helpers/make-local-mirror.ts
import { Volume, createFsFromVolume } from 'memfs';
import type { LocalFsConfig } from '@main/source/local-fs-source';

export function makeLocalMirror(
  manifests: Record<string, unknown>,       // { "com.samsung.vdx.test/1.0.0": manifestObj }
  payloads: Record<string, Buffer>,         // { "com.samsung.vdx.test/1.0.0": zipBuffer }
  catalog: unknown,
  catalogSig: Buffer,
): { fs: ReturnType<typeof createFsFromVolume>; config: LocalFsConfig } {
  const vol = new Volume();
  const fs = createFsFromVolume(vol);
  // write catalog.json + sig
  // write per-app manifests + sigs + payloads
  return { fs, config: { rootPath: '/mirror', fs: fs.promises } };
}
```

Properties of `LocalFsSource` that make it ideal for tests:
- Zero network; deterministic.
- Backed by `memfs` → fully in-process, no temp dirs.
- Range requests implemented via file seek → exercises the same code path as real resume.
- ETag via mtime → tests can verify conditional fetch by mutating the volume.
- `listVersions` via directory scan → tests can add version directories without an index file.

### 7.2. `HttpMirrorSource` testing with in-process HTTP fake

```ts
// test/source/http-mirror.test.ts
import { createServer, type Server } from 'node:http';

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  server = createServer((req, res) => {
    if (req.url === '/catalog.json') {
      res.writeHead(200, { 'ETag': '"abc123"', 'Content-Type': 'application/json' });
      res.end(JSON.stringify(catalog));
    } else if (req.url === '/catalog.json.sig') {
      res.writeHead(200);
      res.end(catalogSig);
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});
afterEach(() => server.close());

it('returns notModified on matching ETag', async () => {
  const src = new HttpMirrorSource({ baseUrl });
  const r1 = await src.fetchCatalog();
  expect(r1.notModified).toBe(false);
  expect(r1.etag).toBe('"abc123"');
  const r2 = await src.fetchCatalog({ etag: '"abc123"' });
  expect(r2.notModified).toBe(true);
});
```

Scenarios to cover:
- `notModified` round-trip via ETag.
- Range request for payload resume.
- 429 → `RateLimitError` with `resetAt` from `Retry-After`.
- 401 → `AuthError`.
- 404 → `NotFoundError`.
- Server sends invalid JSON for manifest → `InvalidResponseError`.
- AbortSignal cancels in-flight stream.

### 7.3. `GitHubReleasesSource` testing with GitHub API fixture

```ts
// test/source/github-releases.test.ts
// Fake server mimics GitHub Releases API responses.
// Uses the same in-process node:http approach.
// Fixture payloads match real GitHub response shapes (condensed):
const releaseFixture = {
  tag_name: 'stable',
  assets: [
    { name: 'catalog.json', browser_download_url: `${fakeApiBase}/download/catalog.json` },
    { name: 'catalog.json.sig', browser_download_url: `${fakeApiBase}/download/catalog.json.sig` },
  ],
};
```

The fixture server must implement:
- `GET /repos/{owner}/{repo}/releases/tags/{tag}` → release object.
- `GET /repos/{owner}/{repo}/releases` (paginated) → array.
- Asset download redirects (GitHub returns `302` to CDN; the fixture can skip redirect and serve directly).
- Rate limit headers (`X-RateLimit-Remaining`, `X-RateLimit-Reset`).
- `401` for bad token.

---

## 8. Migration Path

### 8.1. Phase 1.0 — Feature flag: LocalFsSource only

- `PackageSource` interface and `LocalFsSource` are implemented.
- `GitHubReleasesSource` and `HttpMirrorSource` stubs exist (constructors throw `Error("not implemented in Phase 1.0")`).
- `loadConfig` is implemented but the factory `createSource` always returns `LocalFsSource` in Phase 1.0 (overridden by a compile-time flag).
- Engine tests use `LocalFsSource` backed by `memfs`. All engine tests pass.
- No config file is read by the production Electron shell yet — that wiring lands in Phase 2 alongside the network sources.

The Phase 1.0 override keeps the same public signature as §6.3 — tests that need a custom `fs` (e.g. `memfs`) construct `LocalFsSource` directly rather than going through `createSource`. The override exists only so that any production code path that happens to call `createSource` in Phase 1.0 cannot accidentally instantiate a half-implemented network source. Per §4.4 ("a corrupt config that is silently ignored is worse than an app that refuses to start with a clear error"), the override **fails closed** when the loaded config selects a source that is not yet implemented.

```ts
// src/main/source/create-source.ts (Phase 1.0 override)
const PHASE_1_LOCAL_FS_ONLY = true; // remove in Phase 2

export async function createSource(config: VdxConfig): Promise<PackageSource> {
  if (PHASE_1_LOCAL_FS_ONLY) {
    if (config.source.type !== 'local-fs') {
      throw new ConfigError(
        `Phase 1.0 supports only source.type === 'local-fs'; got '${config.source.type}'. ` +
        `Set source.type to 'local-fs' in vdx.config.json or wait for Phase 2.`,
      );
    }
    const { LocalFsSource } = await import('./local-fs-source');
    return new LocalFsSource(config.source.localFs);
  }
  // ... full dispatch (Phase 2 — see §6.3 for the final form).
  throw new Error('Phase 2 createSource dispatch not yet implemented');
}
```

### 8.2. Phase 2 (Network/Catalog) — GitHub is opt-in via config

- `GitHubReleasesSource` and `HttpMirrorSource` are implemented.
- `loadConfig` is called from the Electron main process at startup.
- The default config (no file found) selects `GitHubReleasesSource` with standard repos.
- Integration tests run `GitHubReleasesSource` against the fixture HTTP server.
- `PHASE_1_LOCAL_FS_ONLY` flag is removed.

### 8.3. Phase 3 (Production hardening) — Full runtime resolution

- `loadConfig` runs before any IPC handlers are registered.
- The loaded `PackageSource` is stored in application context and injected into all coordinators.
- Settings UI exposes a read-only display of which source is active (type + displayName).
- Changing the source requires editing `vdx.config.json` and restarting.

---

## 9. Open Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **IT operator config drift**: Two installations on the same machine have different `vdx.config.json` (next-to-EXE vs APPDATA); behavior diverges silently. | Medium | Log which config file was loaded (without secrets) at startup. Surface active source type in Settings → About. Warn in log if both locations have a file. |
| **LocalFsSource on network shares has torn-file races**: Publisher writes a new payload while the installer is mid-read. | Low | `LocalFsSource` always verifies sha256 after completing the read (via `fetchPayload` contract); a torn file will fail hash verification and surface as `InvalidResponseError`. Do NOT attempt partial retries for local-fs; require a full re-fetch. |
| **`trustRoots` in config allows a rogue IT admin to substitute a different signing key**: The config is not itself signed. | Medium | Mitigation is normative in §4.6 T1 (union semantics) and T9 (per-user APPDATA configs cannot supply `trustRoots`). The embedded key is always trusted; the config can only ADD keys, never remove the embedded anchor. |
| **`developerMode: true` in a production config**: Disables signature enforcement. If an IT admin accidentally distributes this, apps can be installed without trust verification. | Mitigated by §4.6 T8 | Production binaries refuse to start when `developerMode: true` is observed without either (a) a debug-build product code or (b) `VDX_DEV_MODE=1` in the launching environment. The `warn` log + UI banner remain as defence-in-depth. |
| **`HttpMirrorSource` token leaks to logs via error messages**: An HTTP error response body might echo the bearer token back; `undici` might include it in the error message. | Medium | Wrap all `HttpMirrorSource` throws through `redact.ts` before constructing error messages. Add a test fixture that returns the token in an error response and asserts the `SourceError.message` does not contain it. |

---

## 10. 사내망(On-Premises) 전환 가이드

이 섹션은 인터넷이 차단된 사내망 환경 또는 사내 GitLab/HTTP 미러로 옮겨야 할 때를 위한 운영 가이드입니다. 본 스펙의 추상화 덕분에 **바이너리 재빌드 없이 `vdx.config.json` 한 파일만 교체**하면 전환됩니다.

### 10.1. 결정 트리 — 어떤 backend를 쓸 것인가

```
사내망 환경?
├─ 외부 인터넷 부분 허용 (allowlist 기반) ─────────► [A] GitHub Releases + corporate proxy
├─ 사내 HTTP 서버에 미러를 호스팅할 수 있음 ─────► [B] HttpMirrorSource (사내 NGINX/IIS/GitLab Pages)
└─ HTTP 서버조차 없음, 공유 폴더만 가능 ─────────► [C] LocalFsSource (SMB / DFS / NTFS share)
```

세 옵션 모두 **서명 검증은 동일** — 카탈로그/매니페스트의 Ed25519 서명, 페이로드의 sha256은 변하지 않습니다. 변하는 것은 "바이트가 어디서 오는가"뿐입니다.

### 10.2. 옵션 A — GitHub Releases + 사내 프록시

**전제:** 사내 프록시가 `api.github.com` 및 `*.githubusercontent.com`에 대한 HTTPS 트래픽을 허용. 사내 PKI(코퍼릿 CA)가 OS 트러스트 스토어에 설치되어 있다면 자동으로 적용됨 (§3.1, §4.2 design spec §6.5 참조).

**vdx.config.json (Next-to-EXE에 배포):**

```jsonc
{
  "schemaVersion": 1,
  "source": {
    "type": "github",
    "github": {
      "catalogRepo": "samsung/vdx-catalog",
      "selfUpdateRepo": "samsung/vdx-installer",
      "appsOrg": "samsung",
      "apiBase": "https://api.github.com",
      "ref": "stable"
    }
  },
  "proxy": {
    "kind": "explicit",
    "url": "http://corp-proxy.example.com:8080"
  },
  "telemetry": false
}
```

**체크리스트:**
- [ ] OS 트러스트 스토어에 사내 root CA가 설치되어 있는지 (TLS MITM 프록시인 경우).
- [ ] `proxy.url`은 인증정보(`user:pass@`)를 포함하지 마세요. 로그 redaction은 best-effort이지 보장이 아님 (§4.5).
- [ ] 사내 보안팀이 `*.github.com`, `*.githubusercontent.com`, `objects.githubusercontent.com` (CDN)을 모두 allowlist 처리했는지.
- [ ] PAT 사용 시 `contents:read` 스코프만 — fine-grained PAT 권장 (§3.1).

### 10.3. 옵션 B — 사내 HTTP 미러 (권장: 대부분의 사내망)

**전제:** 사내 HTTPS 서버 1대 (NGINX/IIS/Apache/GitLab Pages 모두 가능). 정적 파일 서빙만 필요하므로 별도 애플리케이션 코드 없음.

**디렉터리 구조 — 미러 서버에 배포:**

```
${baseUrl}/
├─ catalog.json
├─ catalog.json.sig
└─ apps/
   └─ com.samsung.vdx.exampleapp/
      ├─ versions.json                  (예: ["1.2.3","1.2.0","1.0.0"])
      └─ 1.2.3/
         ├─ manifest.json
         ├─ manifest.json.sig
         ├─ payload.zip
         └─ assets/
            ├─ icon.png
            └─ EULA.txt
```

이 레이아웃은 §3.2의 `HttpMirrorSource` URL 규약과 1:1로 일치합니다.

**vdx.config.json (Next-to-EXE에 배포):**

```jsonc
{
  "schemaVersion": 1,
  "source": {
    "type": "http-mirror",
    "httpMirror": {
      "baseUrl": "https://vdx-mirror.corp.example.com",
      "token": "optional-bearer-if-mirror-requires-auth"
    }
  },
  "trustRoots": [
    "<base64-of-additional-corporate-signing-key>"
  ],
  "channel": "stable",
  "telemetry": false
}
```

**미러 운영 — 필수 체크리스트:**
- [ ] **HTTPS 필수.** 평문 HTTP는 §4.6 T1과 결합해도 메타데이터(어떤 앱이 설치되는가)를 노출. 사내 PKI 인증서 사용.
- [ ] **`Range` 헤더 지원.** §3.2: payload.zip resume을 위해 MUST. NGINX는 기본 지원, IIS는 정적 파일에 대해 기본 지원. CDN/캐시 앞단이 있다면 Range를 끊지 않게 설정.
- [ ] **`ETag` 응답.** `catalog.json`에 대해 SHOULD. NGINX/IIS의 정적 파일 ETag(파일 mtime+inode 기반)로 충분.
- [ ] **GZIP은 metadata-only.** `Content-Encoding: gzip`을 `payload.zip`에 적용하지 마세요 — 이미 압축된 데이터를 다시 압축해도 의미 없고, sha256 검증은 압축 해제 *후*가 아닌 wire-bytes 기준으로 동작하지 않으면 깨짐. (§4.6 T4 참조: sha256은 디스크에 쓰여진 그대로의 바이트에 대해 검증.) `catalog.json`/`manifest.json`은 gzip 가능.
- [ ] **MIME 타입.** `.json` → `application/json`, `.zip` → `application/zip`, `.sig` → `application/octet-stream`. 일부 IIS 기본 설정은 `.sig`를 `text/plain`으로 보내며 BOM/줄바꿈 변환을 시도하므로 명시 설정 필요.
- [ ] **서명 키 관리.** 사내 코드사이닝 키로 카탈로그·매니페스트를 별도 서명한다면 그 공개키를 `trustRoots`에 추가. **Samsung 임베드 키는 그대로 신뢰됨** (§4.6 T1) — 양쪽 키로 서명한 카탈로그도, 사내 키만으로 서명한 카탈로그도 통과.

**서명 키 분리(권장 패턴):**

| 자산 | 서명자 |
|---|---|
| Samsung 공식 앱 카탈로그 + 매니페스트 | Samsung 임베드 키 (그대로 사용) |
| 사내 전용 앱(LOB) 카탈로그 + 매니페스트 | 사내 PKI 발급 Ed25519 키 (`trustRoots`에 추가) |
| 사내 미러를 통해 재배포되는 Samsung 앱 | Samsung 임베드 키 (재서명 불필요 — 미러는 단순 정적 호스팅) |

### 10.4. 옵션 C — 공유 폴더 / SMB / DFS

**전제:** 인스톨러가 도달할 수 있는 SMB/DFS 공유 또는 로컬 마운트 NTFS 볼륨. 별도 서버 프로세스 없음.

**디렉터리 구조 — 공유 폴더에 배포:** 옵션 B와 동일 레이아웃, 슬래시 대신 운영체제 separator 사용.

**vdx.config.json (Next-to-EXE에 배포):**

```jsonc
{
  "schemaVersion": 1,
  "source": {
    "type": "local-fs",
    "localFs": {
      "rootPath": "//vdx-share.corp.example.com/vdx-mirror"
    }
  },
  "trustRoots": [
    "<base64-of-additional-corporate-signing-key>"
  ],
  "telemetry": false
}
```

**운영 가이드:**
- [ ] **퍼블리셔는 atomic write.** 임시 파일 → rename 패턴으로 배포. SMB의 torn-write를 §4.6 T4의 sha256/서명 검증이 잡지만, 매번 사용자가 다시 시도하는 비용을 줄이려면 publisher가 atomic하게 쓰는 편이 좋음 (§3.3 마지막 단락).
- [ ] **읽기 전용 마운트 권장.** 인스톨러는 read-only 권한으로 충분. write 권한이 있으면 다른 사용자의 캐시 오염 위험.
- [ ] **`rootPath`는 절대 경로.** `\\server\share` UNC 또는 마운트된 드라이브 문자(`Z:\vdx-mirror`). 상대 경로는 §4.4에 의해 거부.

### 10.5. 일반적 전환 절차

**Step 1 — 미러 콘텐츠 동기화.** Samsung GitHub 카탈로그(또는 백오피스에서 받은 릴리스 번들)를 미러 위치에 복사. 가장 간단한 방법은 GitHub Release 자산을 한 번 받아 그대로 미러 디렉터리에 풀어 넣기:
```
gh release download <tag> --repo samsung/vdx-catalog -D /mirror/
gh release download <tag> --repo samsung/vdx-exampleapp -D /mirror/apps/com.samsung.vdx.exampleapp/<version>/
```
인터넷에 닿는 단일 호스트(빌드 서버 등)가 한 번 받아 사내로 푸시하는 air-gap 방식.

**Step 2 — 미러 검증.** 미러에서 카탈로그/매니페스트 서명을 한 번 검증해 두세요. 미러 운영자가 실수로 파일을 잘라도 인스톨러가 발견하기 전에 알 수 있도록.
```
node scripts/verify-mirror.ts --root /mirror   # (Phase 2 도구)
```

**Step 3 — `vdx.config.json` 배포.** §10.2/§10.3/§10.4 중 해당하는 템플릿을 인스톨러 EXE 옆에 두고 그룹 정책/MDM으로 배포. Next-to-EXE 위치(`%ProgramFiles%`)는 관리자 권한이 필요하므로 사용자 임의 변경 불가능 — §4.6 T9의 신뢰 보호와 정합.

**Step 4 — 카나리 배포.** 단일 머신에 새 config를 적용하고 `vdx-installer` 로그에서 다음을 확인:
```
INFO  source.config.loaded { path: "...", scope: "next-to-exe", sourceType: "http-mirror" }
INFO  source.catalog.fetched { etag: "...", sigValid: true }
```
`source.config.shadowed` 경고가 떴다면 `%APPDATA%`에 잔여 config가 있는 것 — 사용자 환경에서 정리 필요.

**Step 5 — 롤아웃.** 카나리가 통과되면 전사 롤아웃. 사용자 머신에 이전 GitHub 기반 config가 캐싱돼 있더라도, Next-to-EXE 우선순위가 높으므로 자동 전환됨 (§4.1).

### 10.6. 회귀 / 트러블슈팅 매트릭스

| 증상 | 원인 가능성 | 해결 |
|---|---|---|
| 시작 시 `ConfigError: Phase 1.0 supports only source.type === 'local-fs'` | 빌드가 Phase 1.0인데 config가 github/http-mirror | Phase 2 빌드로 업그레이드하거나, dev 환경에서는 `local-fs`로 임시 전환 (§8.1) |
| `InvalidResponseError: rollback detected` | 미러가 이전 카탈로그 서빙 중 (publisher가 동기화 안 됨) | publisher 동기화 재실행. 의도적 다운그레이드라면 freshness state 초기화: `freshness.json` 삭제 (§4.6 T6) |
| `AuthError: tokenPresent: true` (HttpMirror) | 미러가 토큰 거부 | `vdx.config.json` `httpMirror.token` 갱신. 키체인 토큰은 GitHub 전용 (§3.1)이므로 미러 토큰은 config에. |
| `InvalidResponseError: Range not supported` (payload) | 미러가 Range 헤더 무시 (CDN 캐시 등) | 미러/CDN 설정에서 Range 활성화. 임시 회피로 §10.5 Step 1의 사전 다운로드 후 LocalFs로 전환 가능. |
| 카탈로그 fetch 후 시그니처 검증 실패 | 사내 키가 `trustRoots`에 없거나, MITM 프록시가 콘텐츠 변조(매우 드뭄) | 사내 PKI 공개키를 `trustRoots`에 추가. 변조 의심이면 `openssl s_client -showcerts`로 미러 인증서 체인 확인. |
| `source.config.field-ignored-appdata: trustRoots` | per-user `%APPDATA%` config가 `trustRoots` 또는 `developerMode`를 설정하려 함 — §4.6 T9에 의해 차단 | 해당 필드는 admin-write Next-to-EXE 위치에 두세요. |

### 10.7. 마이그레이션 체크 — 한눈에

```
□ 미러 옵션 결정 (A / B / C)
□ 미러 인프라 프로비저닝 (HTTPS, Range, ETag, MIME, atomic write)
□ Samsung 카탈로그/매니페스트/페이로드 동기화
□ 사내 키로 추가 서명할 자산 결정 (LOB 앱만? 전부?)
□ trustRoots에 사내 키 추가
□ vdx.config.json 작성 (§10.2/3/4 템플릿 기반)
□ 카나리 머신 1대에서 검증 (source.config.loaded 로그 확인)
□ 그룹 정책/MDM으로 Next-to-EXE 위치에 config 푸시
□ 사용자 머신의 잔여 %APPDATA% config 정리 (shadow 경고 모니터)
□ 롤백 계획 — 이전 config를 백업해 두고, 미러 장애 시 잠시 옵션 A로 폴백 가능하게
```

---
