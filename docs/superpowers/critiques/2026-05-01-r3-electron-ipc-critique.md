# R3 Critique — Electron Host, IPC, Self-Update

**Date:** 2026-05-01  
**Round:** R3 (Electron host + IPC + self-update)  
**Critic:** R3-Critic  
**Status:** Draft — guides R3 implementation and review  

Files audited:

- `src/main/electron-main.ts`
- `src/preload/index.ts`
- `src/shared/ipc-types.ts`
- `src/main/config.ts` (legacy)
- `src/main/catalog-http.ts` (legacy)
- `src/main/config/load-config.ts` (R2)
- `src/main/source/factory.ts`, `src/main/source/index.ts`
- `src/main/catalog/catalog-fetcher.ts`, `manifest-fetcher.ts`, `payload-fetcher.ts`
- Design spec §2 (architecture), §5 (auto-update), §6 (trust), §13 (settings/security)
- Package-source spec §5 (engine integration), §6 (config loader)

---

## 1. Electron Security Audit

### F-01 — `will-navigate` passes all `file://` URLs

**Location:** `electron-main.ts:95`

```ts
if (url.startsWith('file://')) return; // ← no restriction on WHICH file
```

**Risk:** HIGH. If the renderer ever gets a `location.href = 'file:///C:/Windows/System32/...'` injected (e.g. via a malicious manifest's `supportUrl` rendered as a link, or an XSS in rendered markdown), the BrowserWindow navigates to an arbitrary local file and loads it with sandbox-level access to IPC. The check should allow only the single, known, renderer HTML file.

**Fix rule:** Replace the blanket `file://` pass with a strict comparison against the resolved renderer path:

```ts
const rendererFile = pathToFileURL(join(__dirname, '../renderer/index.html')).href;
if (url === rendererFile) return;
```

Anything else — including other `file://` URLs — must be `event.preventDefault()`-ed.

---

### F-02 — `isSafeExternalUrl` permits `http:` — enables cleartext exfiltration

**Location:** `electron-main.ts:118`

```ts
return parsed.protocol === 'https:' || parsed.protocol === 'http:';
```

**Risk:** MEDIUM. Manifest `supportUrl` values (or `homepage` fields rendered as links) can be `http://` to an attacker-controlled server. `shell.openExternal` with a plain HTTP URL sends the OS default browser to that URL, potentially leaking the user's IP or triggering drive-by download prompts. The spec (§6.6) explicitly states "https only".

**Fix rule:** Remove the `http:` branch. Allow `https:` only.

---

### F-03 — `pickVdxpkg` file filter allows `.zip` — arbitrary archive execution path

**Location:** `electron-main.ts:173`

```ts
filters: [{ name: 'VDX Package', extensions: ['vdxpkg', 'zip'] }],
```

**Risk:** MEDIUM. The filter is UI-only on most platforms; a user can type a custom path in the dialog anyway. But advertising `.zip` in the filter invites users to pick arbitrary zip files and hand them to `parseVdxpkg`. A malicious zip that passes signature verification (developer mode or forged key) proceeds to extraction and post-install actions. The canonical extension is `.vdxpkg` — there is no reason to offer `.zip` here.

**Fix rule:** Remove `'zip'` from the extension list. The filter should be `['vdxpkg']` only.

---

### F-04 — `sideloadOpen` reads arbitrary filesystem paths from the renderer

**Location:** `electron-main.ts:187`

```ts
const bytes = nodeFs.readFileSync(parsed.data.vdxpkgPath);
```

**Risk:** HIGH. The renderer supplies `vdxpkgPath` — a raw filesystem path — and main reads it with no restriction beyond Zod validating it is a non-empty string. This is effectively an IPC-exposed `fs.readFile` for any path the renderer names. A compromised renderer (or a crafted URL reaching it via `will-navigate` bypass) can read:

- `paths.installedJson` (full install state, version info)
- `%APPDATA%\Microsoft\Credentials\*` (Windows credential blobs)
- Any user-readable file

The design spec (§2.2) states "Renderer never reaches anything beyond what's in this surface — there is no general `fs` or `shell` exposure." A raw path parameter violates this.

**Fix rule:** `sideloadOpen` should only accept a path that was **returned by `pickVdxpkg`** in the same session. Options:

1. Add a `pickedPaths` session set in main; `pickVdxpkg` stores the returned paths, and `sideloadOpen` validates that `vdxpkgPath` is in that set (exact match).
2. Alternatively, accept only a token from `pickVdxpkg` (the handler returns a token; `sideloadOpen` takes the token, not the path).

Either way, arbitrary renderer-supplied paths must be rejected.

---

### F-05 — `emitProgress` is not restricted to the trusted main window

**Location:** `electron-main.ts:122–125`

```ts
function emitProgress(ev: ProgressEventT): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannels.installProgress, ev);
  }
}
```

**Risk:** LOW (currently). Correct in the single-window model. However, `mainWindow` is a module-level `let` that is written in `createWindow()` — if `createWindow()` is ever called again (possible on macOS `activate` at line 386), a new window is created but `mainWindow` is not re-assigned and old progress events go to the stale reference. More critically: if a future refactor introduces additional `BrowserWindow` instances (e.g. a settings popup or onboarding modal), `webContents.send` on the wrong window could deliver installation state to an untrusted secondary frame.

**Fix rule:** Pin `emitProgress` to the exact `webContents` id of the window that initiated the install. The `ipcMain.handle` callback receives `event: IpcMainInvokeEvent`; capture `event.sender` at `catalogInstall`/`installRun` time and send progress only to that sender. Guard: `if (sender.id !== trustedSenderId) return`.

---

### F-06 — `sideloadSessions.clear()` in `catalogInstall` is a denial-of-service vector

**Location:** `electron-main.ts:320`

```ts
sideloadSessions.clear();
```

Also present at `electron-main.ts:185` in `sideloadOpen`.

**Risk:** MEDIUM. If a renderer issues concurrent IPC calls — `sideloadOpen` followed immediately by `catalogInstall` before the user reaches the wizard — the second call clears the first session, silently losing the in-memory payload buffer. The user sees a "session expired" error with no actionable explanation. More maliciously, a compromised renderer could spam `sideloadOpen` / `catalogInstall` alternately to prevent any install from completing (DoS of the install flow).

A global `sideloadSessions.clear()` also assumes a single concurrent install. The design does not restrict concurrent installs explicitly, but the session map should not be a single-owner structure that any handler can wipe.

**Fix rule:**
- Enforce at most one sideload-in-progress at a time with a dedicated lock flag (or mutex). Reject new `sideloadOpen`/`catalogInstall` calls while the flag is set, returning a clear error.
- Never blindly `clear()` the entire map — delete only the session that the *current* handler owns.

---

### F-07 — No cap on the number of concurrent sideload sessions (DoS via Buffer accumulation)

**Location:** `electron-main.ts:47, 190–208`

**Risk:** MEDIUM. Although the current code calls `.clear()` before each open, if that clear is removed (per F-06), there is no upper bound on how many sessions a renderer can open. Each session holds a full `payloadBytes: Buffer` — potentially 100 MB+ per session. A malicious (or buggy) renderer calling `sideloadOpen` in a tight loop with varying path tokens would exhaust heap.

**Fix rule:** Enforce `sideloadSessions.size < MAX_SIDELOAD_SESSIONS` (recommend `MAX_SIDELOAD_SESSIONS = 3`) before creating a new entry. Return `{ ok: false, error: 'too many open sessions' }` if exceeded. Pair with a session TTL: sessions older than N minutes (suggest 30) should be evicted by a periodic timer.

---

### F-08 — Proxy handling absent in `catalogInstall` / `sideloadOpen` network paths

**Location:** `electron-main.ts:273, 327` (calls to legacy `fetchCatalog` / `fetchPackage`)

**Risk:** MEDIUM (ops). The legacy `catalog-http.ts` uses bare `fetch()` with no proxy override. The R2 spec (package-source spec §4.6, proxy precedence section) explicitly defines a proxy cascade: `HttpMirrorConfig.proxyUrl` → config-level explicit → none → system. The legacy code ignores all of this. In corporate environments behind an explicit HTTP proxy (which is exactly the target audience), catalog fetches fail silently with a generic network error.

**Fix rule:** After migrating to R2 modules (`createPackageSource`), proxy support comes for free through `HttpMirrorSource`/`GitHubReleasesSource`. Do not attempt to retrofit proxy into the legacy code — that is the migration's motivation.

---

### F-09 — `diagHandler` / `paths.installedJson` leak risk (anticipated, per audit scope)

**Location:** `electron-main.ts` — no diagnostic handler exists yet.

**Risk:** MEDIUM (forward-looking). The design spec §2.1.1 requires `diag:export` and `diag:openLogs`. When those handlers are added, they will naturally reference `paths.installedJson`, `paths.logsDir`, etc. — internal paths the renderer never supplied. Returning these paths verbatim in an IPC response breaks the rule that "renderer cannot infer internal host filesystem layout."

**Fix rule:** The `diag:export` handler must:
1. Write a redacted diagnostic bundle to a temp file.
2. Return `{ ok: true }` (no path to renderer); open the destination via `shell.showItemInFolder(tempPath)`.
3. `diag:openLogs` similarly: call `shell.openPath(paths.logsDir)` in main; return only `{ ok: true }`.

Neither handler may return a filesystem path string to the renderer.

---

### F-10 — Missing CSP on the renderer load (dev mode especially)

**Location:** `electron-main.ts:78–81` (dev URL load path)

**Risk:** MEDIUM. The BrowserWindow's `webPreferences` are correct, but there is no `Content-Security-Policy` set on the session before loading the renderer, either via `session.defaultSession.webRequest.onHeadersReceived` or as a meta-tag in the HTML. In dev mode (`ELECTRON_RENDERER_URL`), the Vite dev server may not inject the right CSP. The spec (§6.6) requires "Strict CSP: no `unsafe-inline`, no remote scripts."

**Fix rule:** In `createWindow()`, after constructing `mainWindow`, hook `mainWindow.webContents.session.webRequest.onHeadersReceived` to inject:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'
```

The exact policy is a renderer concern, but main must enforce it as a header. This is the only reliable place to set it for both prod file-load and dev URL-load paths.

---

### F-11 — `devUrl.startsWith(allowedDev)` prefix match is too broad for `will-navigate`

**Location:** `electron-main.ts:93–94`

```ts
if (allowedDev && url.startsWith(allowedDev)) return;
```

**Risk:** LOW–MEDIUM. If `ELECTRON_RENDERER_URL` is `http://localhost:5173`, then `http://localhost:51730/evil` passes this check. Use exact-origin comparison instead:

**Fix rule:**
```ts
const rendererOrigin = new URL(allowedDev).origin;
if (new URL(url).origin === rendererOrigin && url.startsWith(allowedDev)) return;
```
Or more robustly, compare only `new URL(url).href === allowedDev` for the dev entry-point.

---

### F-12 — `catalogFetch` uses the dev pub key for production catalog signature verification

**Location:** `electron-main.ts:278`

```ts
publicKey: await getDevPubKey(),
```

**Risk:** HIGH. `getDevPubKey()` returns the key from `ensureDevKeyPair(paths.keysDir)` — a **per-device, newly generated** Ed25519 keypair stored in `%APPDATA%/vdx-installer/keys/`. This is a developer-mode key, not the Samsung VDX production trust root. Production catalogs are signed with the Samsung HSM key; verifying them against a random dev key will always fail (`signatureValid: false`). The UI shows a "signature invalid" warning in production even for correctly signed catalogs.

The R2 `catalog-fetcher.ts` takes `trustRoots: Uint8Array[]` (union semantics — any match passes). This is the correct model: embed the production Samsung public key in the binary; optionally add the dev key when `developerMode === true`.

**Fix rule:** Load the production trust roots from the embedded constant (`BUILTIN_TRUST_ROOTS` or equivalent). Pass `[productionPubKey, ...(devMode ? [devPubKey] : [])]` to catalog-fetcher. Do NOT use the dev key as the sole trust root for catalog verification.

---

## 2. IPC Contract Gaps

### Missing channels vs design spec §2.1.1

The spec lists these channels; none exist in `IpcChannels` or the preload:

| Channel group | Missing channels | Required by |
|---|---|---|
| Settings | `settings:get`, `settings:set` | §2.1.1, §13.1 |
| Auth/keytar | `auth:setToken`, `auth:clearToken` | §2.1.1, §13.2 first-run PAT flow |
| Diagnostics | `diag:export`, `diag:openLogs` | §2.1.1, §13.1 Advanced section |
| Self-update | `update:check`, `update:run` | §2.1.1, §5.1 |
| Catalog caching | `catalog:refresh` (forced) distinct from `catalog:fetch` | §5.0 (6h tick + user click) |

#### `settings:get` / `settings:set`

```ts
// Request
export const SettingsGetReq = z.object({}); // no payload, returns all settings

// Response
export const SettingsGetRes = z.object({
  language: z.enum(['ko', 'en']),
  updateChannel: z.enum(['stable', 'beta', 'internal']),
  defaultInstallScope: z.enum(['user', 'machine']),
  trayEnabled: z.boolean(),
  autoUpdatePolicy: z.enum(['auto', 'ask', 'manual']),
  developerMode: z.boolean(),
  telemetry: z.boolean(),
});

// settings:set — partial update
export const SettingsSetReq = SettingsGetRes.partial();
export const SettingsSetRes = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
```

Note: `developerMode` changes must re-evaluate `installedStore` — require restart prompt when toggled. Setting `updateChannel` to `'internal'` must be gated by an operator-supplied `channelGrant` claim in the config (§13.1).

#### `auth:setToken` / `auth:clearToken`

```ts
export const AuthSetTokenReq = z.object({
  token: z.string().min(1).max(256), // GitHub PAT; stored via keytar, never logged
});
export const AuthSetTokenRes = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export const AuthClearTokenReq = z.object({}); // no payload
export const AuthClearTokenRes = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
```

The token is written to the OS keychain via `keytar.setPassword('vdx-installer', 'github-pat', token)` per the package-source spec §3.1. The response must NEVER echo the token back, not even a prefix. Confirm storage only.

#### `diag:export` / `diag:openLogs`

```ts
export const DiagExportReq = z.object({}); // main decides destination
export const DiagExportRes = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),     // main opened save dialog; user chose location
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export const DiagOpenLogsReq = z.object({});
export const DiagOpenLogsRes = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
```

See F-09: neither response must contain a filesystem path.

#### `update:check` / `update:run`

```ts
export const UpdateCheckReq = z.object({ force: z.boolean().default(false) });
export const UpdateCheckRes = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    available: z.boolean(),
    version: z.string().optional(),       // new version string if available
    releaseNotes: z.string().optional(),
    critical: z.boolean(),               // minHostVersion raised
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export const UpdateRunReq = z.object({});
export const UpdateRunRes = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), message: z.string() }),  // e.g. "Downloading..."
  z.object({ ok: z.literal(false), error: z.string() }),
]);
```

`update:run` kicks off the background download; a separate push event `update:progress` (not an invoke) sends download percentage. `update:run` called while an install is mid-flight must return `{ ok: false, error: 'install in progress' }` — see §4 of this document.

#### `catalog:refresh` (forced) vs `catalog:fetch` (cached)

The existing `catalog:fetch` re-fetches from the network every time. The spec (§5.0) requires:
- A background 6h tick refresh (force-re-validate against network).
- A user-triggered "refresh" button (same).
- An initial load that can use the cached copy if ETag matches.

Recommendation: rename `catalog:fetch` to `catalog:load` (returns cached if fresh) and add `catalog:refresh` (always network, ignores cache). Alternatively, add a `force: boolean` field to the existing request schema:

```ts
export const CatalogFetchReq = z.object({
  kind: CatalogKindSchema,
  force: z.boolean().default(false),  // true = bypass etag/cache
});
```

---

## 3. Legacy Module Migration Plan

### Duplication map

| Concern | Legacy (delete) | R2 source of truth (keep) |
|---|---|---|
| Config load | `src/main/config.ts` | `src/main/config/load-config.ts` (`loadVdxConfig`) |
| Catalog fetch | `src/main/catalog-http.ts` | `src/main/catalog/catalog-fetcher.ts` (`fetchCatalogVerified`) |
| Package fetch | `src/main/catalog-http.ts` (`fetchPackage`) | `src/main/catalog/payload-fetcher.ts` (`fetchPayloadStream`) |

### What `electron-main.ts` calls today vs. what it should call

| Current call | Replacement |
|---|---|
| `import { loadConfig } from './config'` | `import { loadVdxConfig } from './config/load-config'` |
| `loadConfig([process.cwd(), join(__dirname, '../..')])` | `await loadVdxConfig({ exeDir: app.getPath('exe').replace(/\/[^/]+$/, ''), appDataDir: app.getPath('appData') })` |
| `import { fetchCatalog, fetchPackage } from './catalog-http'` | Remove; use `createPackageSource(config.source)` then `fetchCatalogVerified(source, opts)` |
| `const config = loadConfig(...)` (sync) | `const configResult = await loadVdxConfig(...)` (async, check `ok`) |

### Delete vs keep

**Recommend: delete both legacy files.** Rationale:

1. `src/main/config.ts` uses a different schema (`VdxConfigSchema` with only `catalogs` + `trust` + `network`). The R2 schema (`@shared/config/vdx-config`) is a strict superset (adds `source`, `trustRoots`, `channel`, `proxy`, `developerMode`, `schemaVersion`). Any new code added against the legacy schema is wasted effort and potentially conflicts with R2 security invariants (T9, T10).
2. `src/main/catalog-http.ts` bypasses the `PackageSource` abstraction entirely, uses the dev pub key as the trust root (F-12), and lacks proxy support. Keeping it as a "backup" invites drift.
3. The singleton guard in `loadVdxConfig` (`_loaded` flag) would conflict if both loaders are called; only one can be the source of truth.

**Tests that will break on deletion:**

- Any test that imports `src/main/config.ts` directly. Search: `from './config'` or `from '../config'` in test files.
- Any test that imports `src/main/catalog-http.ts`. Search: `from './catalog-http'` or `from '../catalog-http'`.
- Snapshot tests that assert on `DEFAULT_CONFIG` from the legacy module (the R2 default lives in `@shared/config/defaults.ts`).

### Features in legacy NOT yet in R2

| Feature | Legacy location | R2 status |
|---|---|---|
| `network.userAgent` setting | `config.ts` `DEFAULT_CONFIG` | Present in R2 schema? Unclear — check `@shared/config/vdx-config`. R2 `VdxConfig` exposes `source` but `userAgent` may be absent. Confirm before deleting. |
| `trust.publicKeyPath` (file-based trust key) | `config.ts` `VdxConfigSchema.trust` | R2 uses `trustRoots: Uint8Array[]` (embedded). File-path trust is a different (lower-security) model. If any operator workflow relies on this, it must be documented as "removed in R3" before the file is deleted. |
| Sync config load | `config.ts` `loadConfig` is sync | R2 `loadVdxConfig` is async. `electron-main.ts` must become `async main()` end-to-end (it already is). No action, but confirm nothing calls `loadConfig` from a sync context. |

---

## 4. Self-Update Design

Per design spec §5.1: `electron-updater` with NSIS provider, `samsung/vdx-installer` GitHub Releases.

### 4.1. Where the host check happens

- **On startup**: run `autoUpdater.checkForUpdates()` after `app.whenReady()` and after the main window is shown (not before — the updater may show a native dialog).
- **Scheduled**: 6-hour interval via `setInterval`. Use a monotonic ref via `setInterval(..., 6 * 60 * 60 * 1000)`. Reset the timer on each manual check.
- **User-triggered**: `update:check` IPC channel kicks an immediate check regardless of the scheduled timer.
- Do NOT check before the main window is fully rendered — electron-updater's `error` event needs a target window to be meaningful.

### 4.2. How `selfUpdateRepo` from `vdx.config.json` is consulted

The config field `source.github.selfUpdateRepo` (e.g. `"samsung/vdx-installer"`) specifies which GitHub repo `electron-updater` fetches `latest.yml` from. It should be wired as the `feedURL` for `electron-updater`:

```ts
autoUpdater.setFeedURL({
  provider: 'github',
  owner: selfUpdateRepo.split('/')[0],
  repo: selfUpdateRepo.split('/')[1],
  token: await getGitHubToken(), // optional; anonymous for public repo
});
```

Do NOT use `GitHubReleasesSource.listVersions` for self-update. `electron-updater` has its own blockmap/delta download protocol (`latest.yml`, `*.blockmap`). Using a custom version probe bypasses the delta mechanism and re-downloads the full installer each time. Let `electron-updater` own the version comparison and download.

### 4.3. Signature trust chain for the new EXE

Two layers are required (defense-in-depth):

| Layer | Mechanism | Enforced by | Notes |
|---|---|---|---|
| Authenticode (OS-level) | Windows verifies code signature on every executable launch | Windows Code Integrity | Already required for SmartScreen reputation. Covers the downloaded installer EXE. |
| `electron-updater` signature check | `latest.yml` contains a SHA-512 hash + signature of the `nupkg`/NSIS installer | `electron-updater` built-in | Verifies the downloaded package matches what was published. |

**Recommendation: also require Ed25519-signed `latest.yml`.** Rationale:

The `electron-updater` SHA-512 hash in `latest.yml` is only as trustworthy as the HTTPS delivery of `latest.yml` itself. If a MITM intercepts the `latest.yml` fetch (e.g. a corporate proxy with a custom CA), they can substitute a malicious hash. Adding an Ed25519 signature over `latest.yml` (signed with the same Samsung HSM key used for catalog/manifest signatures) provides the same trust chain already in place for app content. The host verifies the Ed25519 signature before handing `latest.yml` to `electron-updater`.

Implementation sketch:
1. CI publishes `latest.yml` + `latest.yml.sig` to the GitHub Release.
2. Before calling `autoUpdater.checkForUpdates()`, host fetches and verifies `latest.yml.sig` against the embedded VDX public key.
3. If verification fails, abort self-update and log. Do not call `autoUpdater.checkForUpdates()`.

This is a **v1 must-have**, not a later hardening. Once the self-update channel is live without this check, retroactively adding it requires a forced update to reach all existing installs.

### 4.4. Rollback semantics

`electron-updater` (NSIS provider) applies the update by running the new NSIS installer, which overwrites the current EXE. There is no native rollback built into this mechanism.

Recommended approach:

1. Before applying the update, copy the current `vdx-installer.exe` to `vdx-installer.exe.bak` in the same directory (requires write access; admin install path may be read-only — fall back to `%APPDATA%\vdx-installer\backups\`).
2. If the new EXE fails to launch (detectable by: spawning the new EXE with a `--probe` flag and checking exit code 0 within 5 seconds), restore from `.bak`.
3. Log the rollback event. Surface a toast: "Update failed; previous version restored."

Limitation: if the NSIS installer partially completes before crashing, the EXE may be corrupted. The `.bak` copy addresses this for the common case. For the partial-write case, Authenticode verification of the restored `.bak` provides a safety check.

Note: "headless / silent self-update: not v1" (per spec). The "Restart now" button is the only user-visible trigger for applying a downloaded update.

### 4.5. Update-while-installing race

**Contract:** `update:run` (apply/restart) must be rejected while any install, update, or uninstall transaction is in flight.

Implementation:
- Add a module-level `transactionInFlight: boolean` flag, set to `true` at the start of `installRun`/`uninstallRun`/`catalogInstall` and cleared in their `finally` blocks.
- `update:run` handler checks this flag: if `true`, return `{ ok: false, error: 'An install is in progress. Complete or cancel it before restarting.' }`.
- The renderer disables the "Restart to update" button while any wizard/progress screen is active — this is belt-and-suspenders, not the primary guard (the primary guard is in main).

Do NOT call `autoUpdater.quitAndInstall()` from within any async install handler context.

### 4.6. Beta channel

`vdx.config.json.channel === 'beta'` has two distinct scopes:

| Scope | Behavior |
|---|---|
| **Self-update** | `electron-updater` uses a `beta` feed: `latest-beta.yml` instead of `latest.yml`. This means the installer itself is on the beta track and receives pre-release host versions. |
| **App updates** | When resolving which app version to install/update, the channel is passed to `PackageSource.listVersions` (or the catalog entry's `channel` field). `beta` allows `v1.2.0-beta.1` tags in addition to stable tags. |

The `beta` channel setting in `vdx.config.json` is an operator/IT decision (next-to-EXE config). The per-user `installed.json.settings.updateChannel` can be set by the user in Settings → Updates → Channel, subject to the operator ceiling (if operator config says `stable`, user cannot override to `beta` — strip per T9 semantics, applied at *settings read* time, not just config load).

### 4.7. Headless / silent self-update

Not in v1. Do not implement. The `update:run` IPC channel must require user intent.

---

## 5. Hard Rules for the R3 Reviewer

Each rule is a concrete, verifiable gate. The reviewer must check each before approving.

1. **Delete `src/main/config.ts` and `src/main/catalog-http.ts`.** Verify with `git status` showing both files deleted. No import of these paths may remain in any `.ts` file: `grep -r "from './config'" src/main/electron-main.ts` and `grep -r "from './catalog-http'" src/main/` must return no results.

2. **`electron-main.ts` imports `loadVdxConfig` from `./config/load-config`, not `loadConfig` from `./config`.** Verify by reading the import block.

3. **`will-navigate` must not pass arbitrary `file://` URLs.** The handler must compare against the exact renderer file URL, not `url.startsWith('file://')`. Reject with `event.preventDefault()` any file URL that is not the renderer entry point.

4. **`isSafeExternalUrl` must allow `https:` only.** The `http:` branch must be absent. Verify: `grep -n 'http:' src/main/electron-main.ts` must show only `https:` or comments.

5. **`pickVdxpkg` file filter must list `['vdxpkg']` only.** The `'zip'` extension must be removed. Verify by reading the `dialog.showOpenDialog` call.

6. **`sideloadOpen` must validate `vdxpkgPath` against a picker-session allowlist.** Renderer-supplied arbitrary paths must be rejected. Verify: the handler must look up the path in a `pickedPaths: Set<string>` that was populated by `pickVdxpkg`.

7. **The production Samsung Ed25519 public key (not the dev keypair) must be used as the primary trust root for catalog signature verification.** `getDevPubKey()` must NOT be the sole argument to `publicKey`/`trustRoots` in production builds. Verify: production build must embed a constant from `@shared/config/trust-roots.ts` (or equivalent) containing the Samsung VDX public key.

8. **`update:run` must be rejected while `transactionInFlight === true`.** Verify by reading the handler and confirming the flag is set/cleared in all install/uninstall/catalogInstall handlers.

9. **All five missing IPC channels (`settings:get`, `settings:set`, `auth:setToken`, `auth:clearToken`, `update:check`, `update:run`, `diag:export`, `diag:openLogs`) must be registered in `IpcChannels` with Zod schemas in `ipc-types.ts` and handlers in `electron-main.ts` (stubs acceptable if marked `TODO: R3`).** Verify: `Object.keys(IpcChannels).length >= 16`.

10. **`diag:export` and `diag:openLogs` must not return filesystem paths to the renderer.** Their success response must be `{ ok: true }` only. Verify by reading both handlers.

11. **`electron-updater` `feedURL` must be derived from `config.source.github.selfUpdateRepo`, not hardcoded.** Verify: search for any hardcoded `samsung/vdx-installer` string in the updater wiring — must appear only in `@shared/config/defaults.ts`, not in `electron-main.ts`.

12. **The `sideloadSessions.clear()` calls must be replaced.** No handler may clear sessions it doesn't own. Verify: `grep -n 'sideloadSessions.clear' src/main/electron-main.ts` must return zero results.

13. **CSP header must be injected via `session.webRequest.onHeadersReceived`.** Verify: `electron-main.ts` must include a `webRequest.onHeadersReceived` call in `createWindow()`.

---

## 6. Test Coverage Targets for the R3 Tester

### 6.1. Mock-Electron approach

Use `vi.mock('electron', () => ({ ... }))` in vitest. Key shape:

```ts
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((key: string) => `/fake/${key}`),
    whenReady: vi.fn(() => Promise.resolve()),
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    on: vi.fn(),
  },
  BrowserWindow: vi.fn().mockImplementation(() => ({
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    webContents: {
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      session: { webRequest: { onHeadersReceived: vi.fn() } },
      id: 1,
    },
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    removeMenu: vi.fn(),
    on: vi.fn(),
  })),
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));
```

### 6.2. Must test — happy path

| Test | Target | What to assert |
|---|---|---|
| `sideloadOpen` — valid path from picker | `electron-main.ts` handler | Returns `{ ok: true, sessionId: <uuid>, signatureValid }` |
| `sideloadOpen` — path not in picker allowlist | handler | Returns `{ ok: false, error: 'unauthorized path' }` |
| `installRun` — valid session | handler | Session deleted from map in `finally`; progress events emitted |
| `installRun` — unknown sessionId | handler | Returns `{ ok: false, error: 'session expired or unknown' }` |
| `catalogFetch` — network ok, sig valid | handler | Returns `{ ok: true, catalog, signatureValid: true }` |
| `catalogInstall` — no catalog loaded | handler | Returns `{ ok: false, error: /not loaded/ }` |
| `uninstallRun` — app present | handler | `installedStore.update` called; `delete s.apps[appId]` |
| `isSafeExternalUrl` | pure fn | `https://` → true; `http://` → false; `file://` → false; `vscode://` → false; invalid → false |
| `will-navigate` guard | event handler | Prevents navigation to arbitrary `file://`; allows exact renderer URL |
| `settings:get` | new handler | Returns settings from `installedStore` |
| `auth:setToken` | new handler | Calls `keytar.setPassword`; returns `{ ok: true }`; does not echo token |
| `update:check` | new handler | Returns `{ ok: true, available: false }` when no update |
| `update:run` while `transactionInFlight` | new handler | Returns `{ ok: false, error: /in progress/ }` |

### 6.3. Must test — sad path

| Test | Target | What to assert |
|---|---|---|
| `loadVdxConfig` with invalid JSON | config loader | Throws `ConfigError` with path in message |
| `loadVdxConfig` with schema-invalid config | config loader | `ConfigError`; does not fall back silently |
| `catalogFetch` — network timeout | handler | Returns `{ ok: false, error: /timed out/ }` |
| `catalogFetch` — bad sig | new catalog-fetcher path | Returns `{ ok: false, error: /signature/ }` |
| `sideloadOpen` — corrupt zip | handler | Returns `{ ok: false, error: <parseVdxpkg error> }` |
| `installRun` — engine failure | handler | `emitProgress({ phase: 'error' })`; session deleted in `finally` |
| `update:run` during install | handler | Rejected with descriptive error |
| `diag:export` | new handler | Response has no `path` field |
| `auth:clearToken` — keytar unavailable | new handler | Returns `{ ok: false, error: /keytar/ }` |

### 6.4. Cannot test in this phase

- Windows-native Authenticode verification (requires signed binary + Windows OS).
- `electron-updater` end-to-end (requires a published GitHub Release with `latest.yml`).
- NSIS installer rollback (requires the installed host on Windows).
- Registry writes (mocked in MockPlatform; real test requires Windows).
- `shell.openExternal` opening an actual browser (mock and verify the call only).
- Ed25519 signature verification against the Samsung production public key (no HSM access in CI).

### 6.5. Notes

- The `preload/index.ts` surface is thin (no logic, just bridge forwarding). Test it via a single smoke test that verifies `contextBridge.exposeInMainWorld('vdxIpc', ...)` was called with the correct key names matching `IpcChannels`.
- The `onProgress` listener subscription/cleanup in the preload must be tested: subscribe → receive event → unsubscribe → confirm no second call.
- All IPC request schemas must have a round-trip zod parse test (valid input parses; malformed input returns `{ ok: false, error: 'invalid request' }`).

---

## Summary

**File written to:** `docs/superpowers/critiques/2026-05-01-r3-electron-ipc-critique.md`

**Top 5 issues the Reviewer must address:**

1. **F-12 (CRITICAL):** Production catalog verification uses the dev keypair as the trust root. Embed the Samsung VDX production public key. The dev key may only supplement in developer mode.
2. **F-04 (HIGH):** `sideloadOpen` accepts arbitrary filesystem paths from the renderer — a general `fs.readFile` via IPC. Restrict to picker-session-approved paths only.
3. **F-01 (HIGH):** `will-navigate` permits all `file://` URLs. Restrict to the exact renderer file URL.
4. **Rule 1 (BLOCKING):** Delete `src/main/config.ts` and `src/main/catalog-http.ts` and migrate `electron-main.ts` to `loadVdxConfig` + `createPackageSource`. The two schemas are incompatible; running both simultaneously is undefined.
5. **Rule 9 (BLOCKING):** Five IPC channel groups required by the design spec are absent (`settings`, `auth`, `diag`, `update`, `catalog:refresh`). R3 must add at minimum schema + stub handler for each before the renderer team can implement any of §13 (settings, first-run, tray).
