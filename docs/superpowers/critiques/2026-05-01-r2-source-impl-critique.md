# VDX Installer — R2 PackageSource Implementation Critique

**Date:** 2026-05-01
**Scope:** `2026-05-01-package-source-abstraction.md` (R2 implementation). Advisory only. Does NOT modify the spec.
**Read alongside:** `2026-05-01-vdx-installer-design.md` §4 (catalog), §6 (trust), §9 (network).

---

## 1. Implementation Traps

### T-01. ETag round-trip quoting broken by strip-and-re-add

**Where:** Spec §3.2 (`HttpMirrorSource` caching), §7.2 test scenario `notModified round-trip via ETag`.

**Failure mode:** RFC 7232 requires `If-None-Match` to echo the ETag token byte-for-byte. Servers legitimately return weak validators (`W/"abc123"`) and strong ones (`"abc123"`). If the Reviewer stores only the unquoted inner string and re-wraps it in `"..."` on the next request, a weak validator `W/"abc123"` becomes `"abc123"` — a different token. The server will return 200 (full body) instead of 304, burning bandwidth on every refresh cycle.

**Rule:** Store the raw `ETag` header value exactly as received (including any leading `W/`). Pass it verbatim as the `If-None-Match` value. Never parse, strip, or re-quote it. Add a test where the fake server returns `W/"abc"` and assert `If-None-Match: W/"abc"` (not `"abc"`) on the follow-up request.

---

### T-02. `GitHubReleasesSource` rate-limit detection incomplete

**Where:** Spec §3.1, `RateLimitError` construction, §7.3 test scenarios for rate limit headers.

**Failure mode:** GitHub REST v3 returns 403 (not 429) for rate-limit exhaustion when using authenticated tokens. Status 403 alone is ambiguous — it can also mean the token lacks scope or the repo is private. The discriminator is `X-RateLimit-Remaining: 0` combined with status 403. If the Reviewer maps `403 → AuthError` without checking `X-RateLimit-Remaining`, every rate-limit hit will be surfaced as "bad token", prompting the user to re-enter a valid PAT rather than waiting.

**Rule:** For `GitHubReleasesSource`, on every 403 response: check `X-RateLimit-Remaining` header. If present and equal to `"0"`, emit `RateLimitError` with `resetAt` from `X-RateLimit-Reset` (Unix epoch seconds → ms). Only emit `AuthError` when 401 is received OR 403 is received AND `X-RateLimit-Remaining` is absent or non-zero. Additionally, on 403 check the `documentation_url` field in the JSON body: if it contains `rate-limit`, treat as `RateLimitError` regardless of `X-RateLimit-Remaining`.

---

### T-03. `fetchPayload` returning `AsyncIterable` must not be `async function*` that awaits the full response

**Where:** Spec §2.2 (`fetchPayload` signature), §2.3 rationale ("never fully buffered in the main process"), security invariant T5 (1 MiB per yielded chunk).

**Failure mode:** The most natural implementation of `async function* fetchPayload(...)` inside `HttpMirrorSource` is to `await` the `undici` response, then read chunks in a loop. However, `undici`'s `response.body` is a web `ReadableStream`. A subtle trap: if the Reviewer calls `response.arrayBuffer()` (returns the whole response as a single `ArrayBuffer`) instead of iterating `response.body`, the entire payload is buffered in memory before any chunk is yielded. On a 4 GiB payload, this causes an OOM crash in the main process. Even using `response.body` correctly, forgetting to handle back-pressure (e.g., calling `.getReader()` but accumulating chunks into a local array before yielding) defeats the purpose.

**Rule:** `fetchPayload` MUST stream: iterate `response.body` (a `ReadableStream`) using a `for await ... of` loop on the reader, yield each chunk immediately without accumulating. Cap each yielded `Uint8Array` at 1 MiB (split larger chunks from the underlying stream). Never call `.arrayBuffer()`, `.bytes()`, or `.text()` on the response. Add a test where the fake server sends a 3 MiB payload in 1 KiB chunks and assert that the generator yields multiple chunks (not one large chunk), with peak memory bounded.

---

### T-04. `LocalFsSource` path traversal via `assetName` containing `..`

**Where:** Spec §4.6 T3 (path-component validation), §3.3 (`LocalFsSource` behavioral contract).

**Failure mode:** The spec (T3) mandates that `assetName` must not contain `..` segments. However, the spec simultaneously allows slashes in `assetName` (e.g. `"screenshots/01.png"`), which means a simple `assetName.includes('..')` check is insufficient. The Reviewer might implement:

```ts
const fullPath = path.join(rootPath, 'apps', appId, version, 'assets', assetName);
```

An `assetName` of `"../../../catalog.json"` resolves outside the asset directory on any OS. The spec mandates that after resolution, the path MUST start with `path.resolve(rootPath) + path.sep`. A Reviewer who relies on the zod schema's regex for `assetName` at the config layer will miss that `assetName` is caller-supplied at runtime and NOT validated by the config schema.

**Rule:** In `LocalFsSource.fetchAsset` (and `fetchManifest`, `fetchPayload`), after constructing the full path via `path.resolve`, assert that the result starts with `path.resolve(rootPath) + path.sep`. Throw `InvalidResponseError` (not `NotFoundError`) on violation. This check must happen even when the assetName already passed the spec's regex, because a config-layer regex that allows `/` can still yield traversal after `path.resolve`. Add a test: `fetchAsset('com.samsung.vdx.test', '1.0.0', '../../../catalog.json')` throws `InvalidResponseError`.

---

### T-05. `HttpMirrorSource` token echoed in `SourceError.message` via `undici` error chain

**Where:** Spec §4.5 (redaction rules), §9 risk table (`HttpMirrorSource` token leaks to logs).

**Failure mode:** When `undici` throws on a non-2xx response, its error message may include request headers if the request was constructed with debug logging enabled, or when the Reviewer logs `err.message` directly after a 401/403. Even without logging the request headers, the error path often includes the response body — some auth servers echo `Authorization: Bearer <token>` back in a 401 WWW-Authenticate challenge. If `throwSourceError` is called with `message: e.message` before running `redact()`, the token reaches logs and crash reports.

**Rule:** All `SourceError` construction for `HttpMirrorSource` (and `GitHubReleasesSource`) MUST pass the message through `redact.ts` before assigning to `SourceError.message`. The redaction runs at error-construction time, not at log-write time — the spec (§4.5) is explicit on this. Add a test: fake server returns a 401 with body `{"error":"invalid Bearer ghp_TESTTOKEN123"}` and assert that the thrown `SourceError.message` does not contain `ghp_TESTTOKEN123`.

---

### T-06. `fetchPayload` HTTP 200 when Range was requested must be rejected, not silently accepted

**Where:** Spec §2.2 (`fetchPayload opts.range` contract: "Implementations that do not support Range MUST throw an `InvalidResponseError`"), §4.6 T4 (streaming integrity).

**Failure mode:** When `fetchPayload` sends `Range: bytes=N-M` and the server does not support ranges, it returns HTTP 200 with the full file (not 206). The Reviewer may check only for 206 and return an error on any other status, but if the check is `if (status !== 200 && status !== 206) throw ...`, then a 200 on a range request is silently accepted. The caller would then interpret the 200 response (starting at byte 0) as the requested partial range (starting at byte N), causing silent data corruption in the resumed download.

**Rule:** When `opts.range` is provided and a non-zero `range.start` is used, the response MUST be 206. A 200 response to a range request (bytes N–M where N > 0) MUST throw `InvalidResponseError` with message `"Server returned 200 instead of 206 for Range request; server does not support resumable download"`. A 200 response when `range.start === 0` (fetching from the beginning) is acceptable — some servers return 200 with the full body for a range that covers the whole file. Add a test for this exact scenario.

---

### T-07. `GitHubReleasesSource` asset name case sensitivity on GitHub CDN

**Where:** Spec §3.1 (URL layout table), §7.3 (`GitHubReleasesSource` test fixture).

**Failure mode:** GitHub Releases asset names are case-sensitive in the API response (`catalog.json` vs `Catalog.json` are distinct assets). The Reviewer's `fetchCatalog` implementation finds the download URL by filtering `release.assets` for the asset named exactly `"catalog.json"`. If the release has the asset uploaded as `catalog.JSON` or `Catalog.json` (a mistake by the vdx-pack CLI or a manual upload), the filter returns nothing and the result is a `NotFoundError`. Worse — if the Reviewer uses `.find(a => a.name.toLowerCase() === 'catalog.json')` as a "fix", a malicious repository could supply both `catalog.json` and `CATALOG.JSON` as assets; the wrong one might be served first.

**Rule:** Asset lookup MUST use exact case-sensitive string match on `a.name === 'catalog.json'` (not toLowerCase). If zero assets match, throw `NotFoundError`. If more than one asset matches the exact name (GitHub normally prevents this, but the fixture should test it), throw `InvalidResponseError("duplicate asset name")`. Document this rule in a comment in the implementation. Add a test fixture where assets include `Catalog.json` (capital C) and assert `NotFoundError` is thrown.

---

### T-08. `LocalFsSource.fetchPayload` with `range` — end-of-file semantics

**Where:** Spec §3.3 (`fetchPayload` with range: "uses `fs.open` + `read` to seek to `range.start` and yield only the requested bytes"), §2.1 `ByteRange` definition: "half-open byte range [start, end)".

**Failure mode:** The spec defines `ByteRange.end` as exclusive. If the Reviewer passes `length = range.end - range.start` to `fs.read`, they will read exactly the right number of bytes — BUT only when `range.end <= fileSize`. When `range.end > fileSize` (caller requested bytes past end-of-file, which the engine might do if `payload.size` was read from a manifest and the file is shorter due to a torn write), `fs.read` will silently return fewer bytes than requested. The caller has no way to distinguish a short read from a completed range without checking the bytes actually read against the requested length.

Additionally, the `LocalFsSource` emulated ETag (`"${mtimeMs}-${size}"`) must not be computed before `fetchPayload` begins; it must be the mtime at the time of the stat call that initiated the open. Computing it lazily from cached state yields a stale ETag if the file was replaced mid-session.

**Rule:** After `fs.read` completes each chunk, assert `bytesRead === requested`. If `bytesRead < requested` and we have not yet reached `range.end`, throw `InvalidResponseError("short read: file truncated or torn")`. Do NOT silently yield a short chunk. Add a test: truncate a payload.zip in memfs after computing the range, call `fetchPayload` with that range, assert `InvalidResponseError` is thrown (not silent completion).

---

### T-09. `createSource` factory uses non-null assertion on already-validated config

**Where:** Spec §6.3 (`createSource` pseudocode): `config.source.github!` — note the `!` operator.

**Failure mode:** The spec's `createSource` pseudocode uses `config.source.github!` (TypeScript non-null assertion). The discriminated union in zod guarantees that when `source.type === 'github'`, the `github` field is present — but only after schema validation. If `createSource` is ever called with a `VdxConfig` that was constructed manually (e.g., in a test that bypasses `VdxConfigSchema.parse`), the non-null assertion becomes a lie. More concretely: the Phase 1.0 override in the pseudocode passes `config.source.localFs` (no `!`) — that inconsistency could cause the Reviewer to cargo-cult the `!` from the Phase 2 dispatch and produce a runtime TypeError in a branch that a test doesn't exercise.

**Rule:** Replace `config.source.github!` with an explicit type-narrowed access. The TypeScript discriminated union on `source.type` already narrows the type inside each `case` block, so `config.source.github` (no `!`) is correctly typed and safe after narrowing. Remove all non-null assertions in `createSource`. Add a type-level test (using `@ts-expect-error`) that the config field cannot be `undefined` inside the narrowed branch.

---

### T-10. Freshness sequence check on `LocalFsSource` — not needed but MUST not be skipped for real sources

**Where:** Spec §4.6 T6 (freshness/rollback protection), §5.2 (only `catalog-sync.ts` calls `fetchCatalog`).

**Failure mode:** T6 requires that the `catalog-sync.ts` coordinator check a strictly-monotonic `sequence` field inside the signed catalog envelope and compare it to the stored maximum. The trap is that the Reviewer may implement the sequence check inside `fetchCatalog` itself (on the source object) rather than in `catalog-sync.ts`. This breaks the separation-of-concerns principle: `PackageSource` is responsible only for fetching bytes, not for evaluating their semantic content. If the check lives in the source, `LocalFsSource` would also need to implement freshness state, creating a dependency on `%APPDATA%/vdx-installer/state/freshness.json` from within a class that is supposed to be usable from memfs-backed tests.

Separately: if the sequence check is accidentally omitted from `catalog-sync.ts` (because the Reviewer put it in the source), a source swap that removes the check exposes a downgrade attack.

**Rule:** The freshness sequence check MUST live in `catalog-sync.ts`, not in any `PackageSource` implementation. Source implementations are bytes-only. Write a test for `catalog-sync.ts` that constructs a `LocalFsSource` backed by memfs, fetches a catalog with `sequence: 5`, records it, then fetches a catalog with `sequence: 3` and asserts `InvalidResponseError("rollback detected")` is thrown.

---

### T-11. `AbortSignal` propagation — `LocalFsSource` with real `node:fs/promises` ignores signals

**Where:** Spec §2.2 (`fetchPayload opts.signal`, `fetchManifest opts.signal`, `fetchCatalog opts.signal`), spec §3.3 behavioral contract.

**Failure mode:** `undici`'s `fetch` and `request` accept an `AbortSignal` via options and honour it natively. But `LocalFsSource` uses `node:fs/promises` for reads. `fs.promises.readFile` and `fs.promises.open/read` do NOT accept an `AbortSignal` — they run to completion regardless of cancellation. If the Reviewer passes the signal to `fs.promises.readFile(path, { signal })` (which is actually supported since Node 18 for `readFile` but NOT for the lower-level `open/read` path used for streaming range reads), large payload reads may continue after the caller aborts, pinning the event loop.

**Rule:** In `LocalFsSource.fetchPayload`, after each `fs.read` chunk, check `signal?.throwIfAborted()`. This is the correct pattern for manually implementing abort-awareness in a loop that uses APIs without native signal support. The check must happen at the top of the loop body, before yielding the chunk. Add a test: call `fetchPayload`, abort the signal after the first chunk is yielded, and assert that the generator throws `AbortError` rather than completing.

---

### T-12. `displayName` must not be used for UI; it is diagnostics-only

**Where:** Spec §2.2 (`PackageSource.displayName`): "Human-readable label for display in settings / diagnostics." Spec §8.3: "Settings UI exposes a read-only display of which source is active (type + displayName)."

**Failure mode:** The spec says `displayName` is for "diagnostics" but then contradicts itself by noting it appears in the Settings UI in Phase 3 (§8.3). The R1 critique already noted `displayName` is for diagnostics, not primary UI. The trap is that the Renderer might use `displayName` as a localized UI string, leading to a hardcoded English label ("GitHub Releases") appearing in the Korean locale. The Renderer is supposed to localize the source type name via its own i18n keys based on `source.id` (the stable identifier), not `displayName`.

**Rule:** `PackageSource.displayName` is for log lines and crash reports. The Renderer MUST NOT render `displayName` directly in user-facing strings. Instead, the IPC `settings:get` response should return `source.id` (`"github"`, `"http-mirror"`, `"local-fs"`), and the Renderer maps that to a localized string via its own i18n table. Document this in a comment on the `displayName` property. The Reviewer must not add `displayName` to any IPC response shape.

---

## 2. Config Schema Edge Cases

### C-01. `source.type` discriminated union — extra fields allowed by zod's `.optional()`

**Where:** Spec §4.3 (`SourceConfig` zod schema), each union arm uses `z.undefined().optional()` for the non-active fields.

**Trap:** The schema uses `github: z.undefined().optional()` on non-github arms. Zod's `z.undefined()` accepts a missing key OR an explicit `undefined` value. But it does NOT reject an explicit object value for `github` when `type === "http-mirror"`. Wait — zod `z.undefined()` does reject an object. However, in strict mode zod strips unknown keys, and in non-strict mode it passes them through. The discriminated union in the spec does enforce the shape correctly IF `z.object` is used with `.strict()`. Without `.strict()`, a config with both `github: {...}` and `type: "http-mirror"` would pass zod validation (the github block would be preserved in the output), potentially confusing callers who inspect the output object. The spec's pseudocode does not use `.strict()`.

**Rule:** Add `.strict()` to each arm of the `SourceConfig` discriminated union, OR verify that the `z.undefined().optional()` pattern reliably rejects non-undefined values (it does via `z.undefined()` — but add a test). Test case: config with `type: "github"`, `github: { valid fields }`, AND `httpMirror: { baseUrl: "https://..." }` — assert zod validation fails.

---

### C-02. `apiBase` must be HTTPS unless tested differently — schema does not enforce HTTPS

**Where:** Spec §4.3 (`GitHubSourceConfig`): `apiBase: z.string().url()`. No HTTPS enforcement in schema.

**Trap:** The spec says `apiBase` defaults to `"https://api.github.com"` and supports GitHub Enterprise Server via `"https://github.example.com/api/v3"`. The zod schema validates that `apiBase` is a URL but does NOT require HTTPS. An operator who mistakenly sets `apiBase: "http://..."` would have no schema-level protection. Unlike `HttpMirrorConfig.baseUrl` (which also lacks HTTPS enforcement), the GitHub API base is a trust-shifting field subject to T9 (per-user configs cannot override it). A plain-HTTP `apiBase` in a next-to-EXE config is not blocked by T9 and would silently downgrade all API calls to cleartext.

**Rule:** Add a `.refine((url) => url.startsWith('https://'))` to `apiBase` in `GitHubSourceConfig` and to `baseUrl` in `HttpMirrorSourceConfig`. The error message must be explicit: `"apiBase must use HTTPS"`. Allow `http://` ONLY if `developerMode: true` is set AND the binary is a debug build (matching §4.6 T8). The schema-layer check can only enforce the URL prefix; the runtime check for developerMode must happen in `createSource` after config is loaded.

---

### C-03. `trustRoots: []` empty array is not a fatal error — spec gap

**Where:** Spec §4.3 (`trustRoots: z.array(Base64PubKey).max(16).optional()`), §4.6 T1.

**Trap:** T1 states that the embedded key is ALWAYS trusted and `trustRoots` only adds to it. Therefore `trustRoots: []` is semantically valid (it adds no extra keys, the embedded key remains). The schema allows it. However, an IT operator setting `trustRoots: []` when they intended to add a corporate key has made a silent mistake: their LOB apps will fail signature verification, but the error will appear as "invalid signature" at install time rather than at startup when the config is loaded. There is no startup validation that `trustRoots` contains the keys needed to verify the catalog currently being served.

**This is a spec gap, not a bug.** Flag for follow-up: consider a startup check that loads the cached catalog (if present) and validates it against the effective trust set, warning if verification fails with just the embedded key. Do NOT silently proceed.

---

### C-04. `proxyUrl` in `HttpMirrorConfig` vs global `proxy` in `VdxConfig` — no precedence rule

**Where:** Spec §3.2 (`HttpMirrorConfig.proxyUrl`): "Optional proxy override for this source only (default: system proxy from config)."

**Trap:** `VdxConfig.proxy` is the global proxy config. `HttpMirrorConfig.proxyUrl` is a per-source override string (not a `ProxyConfig` discriminated union, just a plain URL string). The two have different shapes. When both are set:
- `VdxConfig.proxy = { kind: "none" }` (bypass all proxies)
- `HttpMirrorConfig.proxyUrl = "http://proxy.corp.example.com:8080"`

Which wins? The spec says `proxyUrl` is "for this source only (default: system proxy from config)" but does not say whether it overrides `kind: "none"`. An operator intending to bypass the global proxy for all sources but still route the mirror through a specific proxy would be in an ambiguous state.

**Rule:** Per-source `proxyUrl` (when set) MUST win over the global `proxy` setting, including `{ kind: "none" }`. Document this explicitly in a comment on `HttpMirrorConfig.proxyUrl`. Add a test: global proxy is `{ kind: "none" }`, `proxyUrl` is set, verify the outgoing request uses the `proxyUrl`. Flag this in the R2 final report as a confirmed decision (see §5, open question OQ-02).

---

### C-05. `schemaVersion` field is `z.literal(1)` — wrong version produces `ConfigError`, but the error message may not guide operators

**Where:** Spec §4.4 validation rules: "schemaVersion not 1 → Hard fail: `loadConfig` throws `ConfigError`."

**Trap:** If a future installer version bumps `schemaVersion` to 2 and a user upgrades the installer but has an old `vdx.config.json` with `"schemaVersion": 1`, zod would reject it. But the reverse — old installer, new config with `"schemaVersion": 2` — also throws `ConfigError`. The zod error message for a literal mismatch is "Invalid literal value, expected 1" which is not operator-friendly. An IT admin who pushed a Phase 3 config to Phase 2 machines would see this error with no guidance.

**Rule:** In `loadConfig`, after zod validation fails, check if the parsed (non-validated) object has a `schemaVersion` field that is a number but not 1. If so, throw `ConfigError` with a targeted message: `"vdx.config.json schemaVersion ${found} is not supported by this installer (expected 1). Upgrade VDX Installer or downgrade the config."` Add this as a pre-zod check before the full `safeParse`. Add a test for `schemaVersion: 2` that asserts the specific message.

---

### C-06. `LocalFsConfig.rootPath` on Windows UNC paths — path resolution differs from drive paths

**Where:** Spec §4.3 `LocalFsSourceConfig`: `ABSOLUTE_PATH_RE` allows `\\server\share\...` UNC paths.

**Trap:** `path.resolve('//server/share/vdx-mirror')` on Windows returns `\\server\share\vdx-mirror` (backslash separator). But `path.resolve` on macOS (the CI platform) returns `//server/share/vdx-mirror` (forward slash). The `ABSOLUTE_PATH_RE` regex covers both forms. However, the traversal guard in `LocalFsSource` (see T-04 above) checks that the resolved path starts with `path.resolve(rootPath) + path.sep`. When `rootPath = "//server/share/vdx-mirror"` on Windows, `path.resolve(rootPath)` = `\\server\share\vdx-mirror` and `path.sep` = `\`. A computed asset path starting with `\\server\share\vdx-mirror\` passes the guard. But if the Reviewer normalizes `rootPath` with `path.posix.resolve` (not `path.resolve`), the UNC path loses its double-slash and becomes `/server/share/vdx-mirror` — the traversal guard now incorrectly rejects ALL assets.

**Rule:** Always use `path.resolve` (not `path.posix.resolve` or `path.win32.resolve`) for runtime path operations. The memfs-backed test environment runs on the host OS (macOS in CI); UNC paths in memfs tests will have forward slashes. Add a platform-tagged comment in `LocalFsSource` that the traversal guard must use `path.resolve` and must be retested on Windows before Phase 3 production deployment.

---

## 3. Test Coverage Gaps

### TC-01. Flaky network simulation not specified for `HttpMirrorSource`

**Spec coverage:** §7.2 lists `AbortSignal cancels in-flight stream` as a scenario but not mid-stream `ECONNRESET`.

**Missing tests:**
- Fake server that sends 512 KiB of a 2 MiB payload then destroys the socket (`req.socket.destroy()`). Assert `NetworkError` with `retryable: true` is thrown from `fetchPayload`.
- Fake server that sends the catalog ETag header then destroys the socket before the body. Assert `NetworkError` (not `InvalidResponseError`).
- Two consecutive `ECONNRESET` failures followed by success on the third attempt. Assert `fetchCatalog` eventually returns the catalog body (retry logic exercised).

---

### TC-02. `LocalFsSource` permission-denied path

**Spec coverage:** Not mentioned. Only ENOENT → `NotFoundError` is specified (§3.3).

**Missing tests:**
- `fetchCatalog` when `rootPath/catalog.json` exists but is mode 000 (chmod on a real tmpdir, not memfs). Assert the error is `NetworkError` (retryable: true) — since the spec maps "other fs errors → NetworkError". Verify the error message does not include the full path (leaks username on Windows).
- `fetchPayload` when the partial download directory is not writable. This is a concern for `payload-downloader.ts` which creates `.partial` files in `%APPDATA%/vdx-installer/cache/`.

---

### TC-03. `GitHubReleasesSource` with no asset named `manifest.json` (case mismatch)

**Spec coverage:** §7.3 fixture covers happy path; no test for asset name variations.

**Missing tests:**
- Release has asset `Manifest.json` (capital M) and no `manifest.json`. Assert `NotFoundError` (not a crash or silent wrong-asset fetch).
- Release has asset `manifest.json` AND `Manifest.json`. Assert `InvalidResponseError("duplicate asset name")` or `NotFoundError` — whichever the implementation defines, but it must be deterministic and documented.
- Release has zero assets. Assert `NotFoundError`.

---

### TC-04. `freshness.json` rollback detection — concurrent write race

**Spec coverage:** §4.6 T6 says the host stores the highest `sequence` ever observed. Not specified: what happens if two catalog-sync calls run concurrently (e.g., startup sync and user-triggered refresh).

**Missing test:**
- Simulate two concurrent `fetchCatalog` calls where both fetch a new catalog with `sequence: 10`. The second write of `freshness.json` must not corrupt the first. Assert `freshness.json` contains `sequence: 10` after both complete (idempotent write, no torn state).

---

### TC-05. Catalog sig fetch 404 when catalog 200 — split success

**Spec coverage:** §7.2 covers catalog ETag scenarios but not partial-fetch failures.

**Missing test:**
- `HttpMirrorSource`: fake server returns 200 for `catalog.json` but 404 for `catalog.json.sig`. Assert the error from `fetchCatalog` is `NotFoundError` with `resource` containing `catalog.json.sig`, NOT a hang or silent return of `{ body: ..., sig: undefined }` (which would cause a null-deref in the signature verifier).
- Same for `GitHubReleasesSource`: release has `catalog.json` asset but no `catalog.json.sig` asset.

---

### TC-06. `versions.json` malformed or absent on `HttpMirrorSource`

**Spec coverage:** §3.2: `listVersions` fetches `${baseUrl}/apps/${appId}/versions.json`; if absent, returns `NotFoundError`. No coverage of malformed content.

**Missing tests:**
- `versions.json` present but contains invalid JSON. Assert `InvalidResponseError`.
- `versions.json` present but is an array of non-semver strings (e.g. `["latest", "stable"]`). Spec says the array is "semver strings, newest first" — caller expects parseable semver. Assert the implementation either throws `InvalidResponseError` or filters invalid entries (must be documented and tested).
- `versions.json` exceeds 256 KiB cap (T5). Assert `InvalidResponseError`.

---

## 4. Hard Rules for the Reviewer

1. **File placement is fixed.** All three source implementations MUST be placed in `src/main/source/<id>-source.ts` (`github-releases-source.ts`, `http-mirror-source.ts`, `local-fs-source.ts`). The factory MUST be `src/main/source/create-source.ts`. The interface and supporting types MUST be in `src/shared/source/package-source.ts`. The config schema MUST be in `src/shared/source/config-schema.ts`. No exceptions; no additional source files in `src/shared/`.

2. **`src/shared/` must have zero Node built-in imports.** The zod schema file (`config-schema.ts`) and `package-source.ts` are in `src/shared/` because the Renderer imports them. Add a CI lint rule: `no-restricted-imports` for `node:*` in all files under `src/shared/`. Semantic validation (e.g., `fs.access` on `rootPath`) belongs in `src/main/source/`, not the schema.

3. **Hardcoded source strings are banned outside `config-defaults.ts`.** Run `grep -r "samsung/vdx-catalog\|api.github.com\|samsung/vdx-installer" src/` as part of the PR checklist. The only allowed match is `src/main/source/config-defaults.ts`. Any other match is a blocking defect.

4. **`fetchPayload` must never buffer the full response.** The implementation must stream via `AsyncIterable<Uint8Array>`. Add a comment on the method body: `// MUST NOT call .arrayBuffer(), .bytes(), or .text() — stream only.` The code reviewer must grep for `.arrayBuffer()` and `.bytes()` in all three source files before approving.

5. **ETag values must be stored and re-sent verbatim.** Do not parse, normalize, or re-quote `ETag` header values. Store the raw header string (including `W/` prefix for weak validators). The `CatalogFetchResult.etag` field carries this raw string. Test must assert exact byte-for-byte round-trip.

6. **All `SourceError` messages must pass through `redact.ts` before construction.** This is true even for `LocalFsSource` errors (which may include file paths that contain usernames — see §4.5 redaction of `rootPath`). The `throwSourceError` helper in `package-source.ts` must call `redact()` on its `message` parameter. Add a test that a `LocalFsSource` error for a path under `os.homedir()` has the home prefix replaced with `~`.

7. **Path traversal guard is mandatory in `LocalFsSource` for all four public methods.** Not just `fetchAsset` — also `fetchManifest`, `fetchPayload`, and `listVersions` (when it scans directories). Each method must independently verify that the constructed path starts with `path.resolve(rootPath) + path.sep`. Do not extract to a shared helper that is accidentally skipped in one method.

8. **The Phase 1.0 `PHASE_1_LOCAL_FS_ONLY` constant must be a compile-time constant, not a runtime config.** It must be `const PHASE_1_LOCAL_FS_ONLY = true as const` so TypeScript narrows the `if` branch and the dead `github`/`http-mirror` branches are pruned from the Phase 1.0 bundle by the bundler (tree-shaken). Do NOT use `process.env.PHASE` or a config flag — the Phase 1.0 constraint must be invisible to the runtime config layer.

9. **`loadConfig` must never be called more than once per process.** Wrap the export with a module-level singleton guard: `let _config: VdxConfig | undefined`. If called twice, throw `Error("loadConfig called more than once; config is immutable for the process lifetime.")`. This enforces the spec's "read once at application startup" rule and prevents test pollution where one test's `loadConfig` call leaks into another.

10. **AbortSignal must be checked at each `fs.read` iteration in `LocalFsSource.fetchPayload`.** Call `signal?.throwIfAborted()` at the top of the read loop, before yielding. Do not check only at the start of `fetchPayload` — a long payload can hold the event loop across many iterations before the signal fires.

11. **`createSource` must use TypeScript discriminated union narrowing, not non-null assertions.** Remove all `!` operators from `config.source.github!`, `config.source.httpMirror!`, `config.source.localFs!`. After `case 'github':`, TypeScript already narrows `config.source` to the github arm. Run `tsc --noEmit` in strict mode with `"strict": true` and `"noUncheckedIndexedAccess": true`; verify zero errors.

12. **`catalog-sync.ts` owns the freshness sequence check, not any `PackageSource`.** The sequence comparison against `freshness.json` must happen in `catalog-sync.ts`. No `PackageSource` implementation may read or write `freshness.json`. Add a lint boundary rule or an architectural decision record comment that enforces this.

---

## 5. Open Questions

The Reviewer MUST flag these in the R2 final report rather than deciding silently.

**OQ-01. Which proxy wins: global `VdxConfig.proxy` or `HttpMirrorConfig.proxyUrl`?**
The spec states `proxyUrl` is "for this source only (default: system proxy from config)" but does not say whether it overrides `{ kind: "none" }`. The implementation must choose one behavior and document it explicitly. Candidate answer: per-source `proxyUrl` always wins over the global setting (including `none`). If adopted, test the combination; if not adopted, remove `proxyUrl` from the interface.

**OQ-02. What is the retry budget for `GitHubReleasesSource` on `RateLimitError`?**
The spec defines retry behavior for `NetworkError` (3 attempts, exponential backoff) and for `RateLimitError` (wait until `resetAt`, max 60 s). But for `GitHubReleasesSource`, `resetAt` can be up to 60 minutes away (unauthenticated: 60 req/h window). The spec caps the wait at 60 s, but does not say whether to retry after 60 s if the rate limit is still active. The implementation must decide: give up after 60 s with `RateLimitError` surfaced to the engine, or retry once more after 60 s. Surface this decision in the R2 report.

**OQ-03. Are `appId`, `version`, and `assetName` validated by the source or by callers?**
Spec §4.6 T3 says "every `appId`, `version`, and `assetName` value passed to a `PackageSource` method MUST be validated by the source before path/URL construction." This means the source is the last line of defense. But the catalog-sync and manifest-fetcher coordinators also validate these values before calling the source. If both validate, mismatches in the regex patterns will produce confusing errors. Decide: canonical validation lives in the source (callers may skip) or in the coordinators (sources assert-only). Document the decision.

**OQ-04. What happens when `fetchPayload` is abandoned mid-stream (process exit)?**
Spec §4.6 T7 says the implementation MUST delete the `.partial` file when `fetchPayload`'s caller aborts. On `AbortSignal`, this is straightforward. On ungraceful process exit (SIGKILL, power loss), it is not — the cleanup runs at next startup via the 24-hour reaper. But the spec also says the reaper deletes `.partial` files older than 24 h. If an install takes 25 h (paused laptop), the reaper deletes the in-progress partial file. Is 24 h the right TTL? The Reviewer must pick a TTL and document it; surface in R2 report if 24 h is not appropriate for the target deployment (e.g., slow enterprise connections on large payloads).

**OQ-05. Does `LocalFsSource.listVersions` fallback to directory scan expose timing attacks?**
The spec (§3.3) says `listVersions` scans subdirectory names in `apps/${appId}/` when `versions.json` is absent. On a network share (SMB), directory listing is not atomic and can interleave with a publisher writing a new version directory. A partial directory entry could produce a version string like `"1.2."` (truncated name). The implementation must either: (a) validate each directory name against the semver regex and silently skip invalid entries, or (b) throw `InvalidResponseError` on the first invalid entry. Decide and document; test with a memfs volume that has a non-semver directory name alongside valid ones.
