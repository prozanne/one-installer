# VDX Installer — Package Source Abstraction Spec

**Date:** 2026-05-01
**Status:** Draft v1
**Scope:** Extension to `2026-05-01-vdx-installer-design.md`. Defines a clean abstraction layer so the archive backend (GitHub, HTTP mirror, local filesystem) is swappable via a single config file without rebuilding the installer.
**Does NOT modify** the main design spec. All additions are additive.

---

## 1. Goal & Non-Goals

### 1.1. Goal

- The archive URL (catalog location, manifest location, payload location) is controlled by a single `vdx.config.json` file readable at runtime.
- Swapping from GitHub Releases to an HTTP mirror or an on-premises GitLab instance requires only editing that config file — no recompile, no code change, no registry tweak.
- The engine core (R1) has zero hardcoded references to `"github"`, `samsung/vdx-catalog`, `api.github.com`, or any org-specific string.
- The abstraction is available in R1 as a `LocalFsSource` stub so the engine is testable without a network. Real sources arrive in R2 (network layer phase).

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

/** Factory helper to build a SourceError and throw it. */
export function throwSourceError(e: SourceError): never {
  const err = new Error(e.message);
  (err as unknown as Record<string, unknown>)['sourceError'] = e;
  throw err;
}

/** Type-guard to extract a SourceError from a caught value. */
export function isSourceError(e: unknown): e is Error & { sourceError: SourceError } {
  return (
    e instanceof Error &&
    typeof (e as Record<string, unknown>)['sourceError'] === 'object'
  );
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
```

### 2.3. Design rationale

- `fetchPayload` returns `AsyncIterable<Uint8Array>` rather than `Promise<Uint8Array>` so that large payloads are never fully buffered in the main process. The engine pipes chunks to disk.
- `fetchAsset` returns `Promise<Uint8Array>` because assets (icons, EULAs) are small and uniform buffering is fine.
- `listVersions` is optional (`?`) so `LocalFsSource` and `HttpMirrorSource` can omit it if the directory layout does not support version enumeration without an index file.
- The interface carries no concept of "current channel" — callers pass channel as a hint to `listVersions` only.
- Error handling uses throw (not `Result<T,E>`) at the source boundary because source errors are exceptional, not flow-control values. The engine's own `Result<T,E>` type is used above the source call sites.

---

## 3. Three Implementations (Interface Sketch — Implementation in R2)

These sections define the constructor signature, config shape, and behavioral contract for each implementation. Code bodies are deferred to R2.

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
   * App repo name is inferred as `${appsOrg}/${appId.split('.').at(-1)}`.
   * Override via catalog app entry's `repo` field.
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

**PAT management:**
- Stored in OS keychain via `keytar` under service name `"vdx-installer"`, account `"github-pat"`.
- Never logged; `redact.ts` strips `ghp_...` tokens from any string before writing to log.
- If token refresh is needed (OAuth app flow), that is R3+ scope.

**Caching:**
- ETag from `X-RateLimit-*` headers is stored alongside catalog in `%APPDATA%/vdx-installer/cache/catalog/`.
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
- Retries: 3 attempts with exponential backoff for `NetworkError` and `RateLimitError`.
- Timeout: configurable per-request; default 30 s for manifests/assets, no global timeout for payload stream (the engine controls this via AbortSignal).
- HTTP 404 → `NotFoundError`.
- HTTP 401 / 403 → `AuthError`.
- HTTP 429 → `RateLimitError` with `resetAt` parsed from `Retry-After`.
- HTTP 5xx → `NetworkError` (retryable).
- Any non-JSON body where JSON expected → `InvalidResponseError`.

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
   */
  fs?: typeof import('node:fs/promises');
}

/**
 * LocalFsSource is the canonical source for all engine tests.
 * It is the ONLY source available in Phase 1.0 (R1).
 * It is feature-flagged off in production until R2.
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

**Behavioral contract:**
- ENOENT → `NotFoundError`.
- Other fs errors → `NetworkError` (retryable: true, so callers can retry on transient share disconnects).
- `fetchPayload` with `range` uses `fs.open` + `read` to seek to `range.start` and yield only the requested bytes.
- ETag: computed as `"${mtimeMs}-${size}"` on catalog.json; stored and compared to detect catalog freshness.
- Atomic visibility: on network shares, partial writes by the publisher may result in a torn file. `LocalFsSource` detects this by verifying that the file size matches the `Content-Length` equivalent embedded in `versions.json`; if no index exists, callers must verify sha256 after fetch (which they always do for payload).

---

## 4. `vdx.config.json` Schema

### 4.1. File location & precedence

The host searches for `vdx.config.json` in this order, using the **first file found**:

1. **Next-to-EXE**: same directory as `vdx-installer.exe` (supports IT pre-configured installs).
2. **APPDATA**: `%APPDATA%\vdx-installer\vdx.config.json` (user-controlled override).
3. **Built-in defaults**: hardcoded in `src/main/source/config-defaults.ts` (GitHub source with standard repos).

Rule: the first file found wins entirely. There is no deep-merge across locations. This is intentional — an IT administrator placing a config next to the EXE knows exactly what they are overriding.

**Reload semantics:** Config is read once at application startup. Changes to `vdx.config.json` take effect only after the application is restarted. There is no hot-reload. A diagnostic warning is emitted if both locations have a file.

### 4.2. JSON schema

```jsonc
// vdx.config.json — schemaVersion 1
{
  // Must be present and equal to 1 for this spec version.
  "schemaVersion": 1,

  // Which source backend to use. Exactly one of the backend-specific
  // blocks must be populated (matching the "type" value).
  "source": {
    "type": "github",   // or "http-mirror" or "local-fs"

    // Populated when type == "github"
    "github": {
      "catalogRepo": "samsung/vdx-catalog",
      "selfUpdateRepo": "samsung/vdx-installer",
      "appsOrg": "samsung",
      "apiBase": "https://api.github.com",
      "ref": "stable"
    },

    // Populated when type == "http-mirror"
    "httpMirror": {
      "baseUrl": "https://vdx.example.com"
    },

    // Populated when type == "local-fs"
    "localFs": {
      "rootPath": "C:/Program Files/Samsung/VDX-Mirror"
    }
  },

  // Ed25519 public keys trusted to sign catalogs and manifests.
  // Each entry is a base64-encoded 32-byte Ed25519 public key.
  // Multiple keys enable key rotation without a host upgrade.
  // If omitted, the host's embedded key is used as the sole trust root.
  "trustRoots": [
    "base64-encoded-32-byte-ed25519-pubkey-1",
    "base64-encoded-32-byte-ed25519-pubkey-2"
  ],

  // Default channel for catalog browsing. App-level override via catalog entry.
  "channel": "stable",   // or "beta" or "internal"

  // HTTP proxy configuration.
  "proxy": {
    "kind": "system",   // use OS proxy settings
    // or:
    "kind": "explicit",
    "url": "http://proxy.corp.example.com:8080"
    // or: "kind": "none" to bypass all proxies
  },

  // Disable telemetry entirely (overrides user setting).
  "telemetry": false,

  // Developer mode: allow installing manifests without a valid signature.
  // MUST NOT be true in production-distributed configs.
  "developerMode": false
}
```

### 4.3. Zod schema

**File:** `src/shared/source/config-schema.ts`

```ts
import { z } from 'zod';

const Base64PubKey = z
  .string()
  .refine(
    (s) => {
      try {
        return Buffer.from(s, 'base64').length === 32;
      } catch {
        return false;
      }
    },
    { message: 'trustRoots entry must be a base64-encoded 32-byte Ed25519 public key' },
  );

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
  rootPath: z.string().min(1),
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
  trustRoots: z.array(Base64PubKey).optional(),
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
| `source.type` is `"github"` but `source.github` is missing | Zod discriminated union rejects; `ConfigError`. |
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
| `source.localFs.rootPath` | Replace `C:\Users\<username>\...` with `~\...` (via `redact.ts`). |
| `trustRoots[*]` | Log only first 8 chars of each entry, suffix `...` (fingerprint, not full key). |
| `proxy.url` | Strip credentials from URL before logging (regex on `//user:pass@` pattern). |

---

## 5. Engine Integration (R1 Implications)

### 5.1. Core principle

The R1 engine (Phase 1.0 plans) operates exclusively on data that has already been fetched and placed on disk or in memory. It has no knowledge of `"github"`, `api.github.com`, or any network URL.

Concretely: every engine function that consumes a manifest or payload accepts **either**:
- A `Buffer` / `Uint8Array` (already-fetched bytes), or
- A `PackageSource` instance + coordinates (appId + version) via dependency injection.

The `PackageSource` dependency injection point is the **engine façade** (`src/main/index.ts`), not the inner engine functions. Inner functions (`runInstall`, `runUninstall`, `validateManifestSemantics`, etc.) never see a `PackageSource`.

### 5.2. Engine surface that depends on this abstraction

The following components are the **only** engine-layer touch points for source-aware behavior:

| Component | Interaction with source |
|---|---|
| `src/main/engine/install.ts` | Accepts pre-fetched `payloadBytes: Buffer`. Knows nothing about where bytes came from. |
| `src/main/packages/vdxpkg.ts` | Accepts pre-fetched `vdxpkgBytes: Buffer`. Same. |
| `src/main/packages/signature.ts` | Accepts raw `message` + `signature` bytes. Same. |
| `src/main/source/catalog-sync.ts` (R2) | The ONE component that calls `PackageSource.fetchCatalog`. Validates sig, stores to cache. |
| `src/main/source/manifest-fetcher.ts` (R2) | Calls `PackageSource.fetchManifest`. Validates sig. |
| `src/main/source/payload-downloader.ts` (R2) | Calls `PackageSource.fetchPayload`. Streams to `.partial` file, then verifies sha256 and renames. |

R1 implementations of the R2 components above use `LocalFsSource` exclusively (feature flag, see §8).

### 5.3. Dependency injection pattern

```ts
// src/main/engine/install.ts — current signature (R1)
export interface InstallInput {
  manifest: Manifest;
  payloadBytes: Buffer;           // pre-fetched; engine does not call source
  wizardAnswers: Record<string, unknown>;
  platform: Platform;
  runner: TransactionRunner;
  hostExePath: string;
  scope?: 'user' | 'machine';
}

// src/main/source/install-coordinator.ts — R2 addition
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

The `InstallCoordinator` (R2) calls `source.fetchManifest`, verifies signature with `verifySignature`, calls `source.fetchPayload` + streams to cache, then calls `runInstall` with the pre-fetched buffer. The engine itself remains source-agnostic.

### 5.4. Resolver tests

Engine unit tests (R1) construct a `LocalFsSource` pointing at `test/fixtures/` to test the full path from manifest fetch through install. This validates the source interface as well as the engine logic:

```ts
// In test/engine/install-e2e.test.ts (R2 addition)
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
  const candidates: string[] = [];
  if (exeDir !== null) {
    candidates.push(path.join(exeDir, 'vdx.config.json'));
  }
  const appData = process.env['APPDATA'] ?? process.env['HOME'] ?? '';
  candidates.push(path.join(appData, 'vdx-installer', 'vdx.config.json'));

  // 2. Try each candidate in order.
  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = await fs.readFile(candidate, 'utf-8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; // not found, try next
      throw new ConfigError(`Cannot read ${candidate}: ${(e as Error).message}`);
    }

    // 3. Parse JSON — hard fail on syntax error.
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      throw new ConfigError(`Failed to parse ${candidate}: ${(e as Error).message}`);
    }

    // 4. Validate schema — hard fail on invalid.
    const result = VdxConfigSchema.safeParse(obj);
    if (!result.success) {
      throw new ConfigError(
        `Invalid vdx.config.json at ${candidate}:\n` +
        result.error.errors.map((e) => `  ${e.path.join('.')}: ${e.message}`).join('\n'),
      );
    }

    // 5. Warn if both locations have a file (checked lazily on second found).
    logger.info('source.config.loaded', { path: candidate, sourceType: result.data.source.type });
    return result.data;
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
```

### 6.2. Built-in defaults

**File:** `src/main/source/config-defaults.ts`

```ts
// These are the ONLY place in the codebase where "samsung/vdx-catalog" and
// related strings appear. All other code reads from the loaded VdxConfig.
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
  channel: 'stable' as const,
  telemetry: true,
  developerMode: false,
};
```

**Enforcement rule for reviewers:** Run `grep -r "samsung/vdx-catalog\|api.github.com\|samsung/vdx-installer" src/` as part of the PR checklist. The only allowed match is `src/main/source/config-defaults.ts`. Any other match is a blocking defect.

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

Every engine test that previously supplied raw `payloadBytes: Buffer` directly should continue to do so (engine is source-agnostic). Integration tests that exercise the coordination layer (R2+) use `LocalFsSource` backed by `memfs`:

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

### 8.1. R1 (Phase 1.0) — Feature flag: LocalFsSource only

- `PackageSource` interface and `LocalFsSource` are implemented.
- `GitHubReleasesSource` and `HttpMirrorSource` stubs exist (constructors throw `Error("not implemented in R1")`).
- `loadConfig` is implemented but the factory `createSource` always returns `LocalFsSource` in R1 (overridden by a compile-time flag).
- Engine tests use `LocalFsSource` backed by `memfs`. All engine tests pass.
- No config file is read in the Electron shell (Phase 1.1 concern).

```ts
// src/main/source/create-source.ts (R1 override)
const R1_FORCE_LOCAL_FS = true; // remove in R2

export async function createSource(config: VdxConfig, testFs?: unknown): Promise<PackageSource> {
  if (R1_FORCE_LOCAL_FS) {
    const { LocalFsSource } = await import('./local-fs-source');
    return new LocalFsSource({ rootPath: '/dev-mirror', fs: testFs as never });
  }
  // ... full dispatch (R2)
}
```

### 8.2. R2 (Network/Catalog Phase) — GitHub is opt-in via config

- `GitHubReleasesSource` and `HttpMirrorSource` are implemented.
- `loadConfig` is called from the Electron main process at startup.
- The default config (no file found) selects `GitHubReleasesSource` with standard repos.
- Integration tests run `GitHubReleasesSource` against the fixture HTTP server.
- `R1_FORCE_LOCAL_FS` flag is removed.

### 8.3. R3 (Electron Shell / Production) — Full runtime resolution

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
| **`trustRoots` in config allows a rogue IT admin to substitute a different signing key**: The config is not itself signed. | Medium | Document clearly: the embedded key in the EXE is the highest-trust root; `trustRoots` in config is additive (used for key rotation only). Engine must verify against the union of embedded key AND config keys; never config-only. Spec this constraint in R2. |
| **`developerMode: true` in a production config**: Disables signature enforcement. If an IT admin accidentally distributes this, apps can be installed without trust verification. | Low | The engine always emits a `warn`-level log and shows a UI banner when `developerMode` is true. Future: consider requiring a specific env var (`VDX_DEV_MODE=1`) in addition to the config flag, making accidental deployment harder. |
| **`HttpMirrorSource` token leaks to logs via error messages**: An HTTP error response body might echo the bearer token back; `undici` might include it in the error message. | Medium | Wrap all `HttpMirrorSource` throws through `redact.ts` before constructing error messages. Add a test fixture that returns the token in an error response and asserts the `SourceError.message` does not contain it. |
