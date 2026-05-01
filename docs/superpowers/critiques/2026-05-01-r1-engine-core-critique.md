# VDX Installer — R1 Engine Core Critique

**Date:** 2026-05-01
**Scope:** Phase 1.0 implementation plan (Parts 1–4) + test plan.
**Read alongside:** `2026-05-01-vdx-installer-design.md` (the spec being implemented).
**This document does NOT modify any plan.** It is advisory for Reviewer agents.

---

## 1. Specification Gaps

### 1.1. Concurrent install behavior — underspecified

**Where:** Design spec §7 (transactional install), data-model §4 (`INSTALLED_APP` entity). Neither document specifies what happens when two processes attempt to install the same app simultaneously.

**Gap detail:**
- The lock (`src/main/state/lock.ts`) uses `wx` (exclusive create) semantics on a lockfile. This prevents two goroutines inside the same process from racing, and prevents two separate `vdx-installer.exe` instances from racing.
- But: the design does not specify whether the second caller receives an error, blocks with a timeout, or sees a silent no-op. The plan (Part 4, Task 25) implements the lockfile but the caller (`runInstall` in Part 4, Task 22) does not call `acquireAppLock`. Lock acquisition is implemented in isolation but never wired into the install orchestrator.
- **Missing:** the `runInstall` / `runUninstall` functions never call `acquireAppLock`. This is a functional gap, not just a spec gap.

### 1.2. Journal `txid` format and recovery ordering — underspecified

**Where:** Design spec §7.4 ("transactional install") mentions "journal" but gives no format for `txid`. Plan Part 3 Task 14 defines `txid` as `z.string().uuid()`, which is good, but:
- There is no spec on how `recoverPending` should *order* recovery when multiple pending transactions exist (e.g., two installs were in-flight when the process crashed). Reverse-chronological? Forward? Alphabetical by txid?
- The plan's `recoverPending` (Part 3, Task 15, step 2) simply returns all non-committed entries with no ordering guarantee. The caller (Electron shell, Phase 1.1) must know the ordering to present them correctly to the user.

### 1.3. `when` expression precedence — underspecified at spec level

**Where:** Design spec §3.5 defines `when` expressions but does not give a formal grammar or operator precedence table. Plan Part 1, Task 7 implements a hand-written recursive-descent parser with this precedence (highest to lowest):

1. `!` (unary)
2. `==` / `!=`
3. `&&`
4. `||`

This is standard C-family precedence, but it is never stated in the design spec. App team developers writing manifests cannot know from the spec whether `{{a}} || {{b}} && {{c}}` means `{{a}} || ({{b}} && {{c}})` or `({{a}} || {{b}}) && {{c}}`. The spec must document the precedence table. Without it, manifests written "intuitively" may evaluate differently than intended.

### 1.4. Exec timeout granularity — underspecified

**Where:** Design spec §3.6 (`exec` action), manifest schema `timeoutSec` field. Plan Part 4, Task 21 enforces `z.number().int().positive().max(EXEC_TIMEOUT_MS_MAX / 1000)` = max 300 seconds.

**Gap:** The spec does not define what happens when `exec` times out:
- Does the installer kill the process (`SIGKILL` / `TerminateProcess`)? Try graceful first?
- Does the installer roll back after a timeout?
- Does a timed-out exec count as a journal entry (the plan records `exitCode` but there is no `timedOut` field in the journal schema)?
- `ExecResult` in `Platform` interface has a `timedOut` boolean but `JournalEntry` for `exec` only records `exitCode`. A timed-out process may have `exitCode: -1` or `exitCode: 0` depending on OS.

The plan (Part 3, Task 19, `exec.ts`) throws `"exec timed out after Ns"` but does not record `timedOut: true` in the journal. Rollback semantics on timeout are not specified anywhere.

### 1.5. Locale fallback resolution — underspecified

**Where:** Design spec §12 (i18n) and `Localized` type throughout. The `Localized` object is `{ default: string } & Record<string, string>`.

**Gap:** No spec on fallback chain:
- If `language = "zh-TW"` and manifest has `{ "zh": "...", "default": "..." }` — does it use `"zh"` (truncate to language subtag)?
- If `language = "en-GB"` and manifest has `{ "en-US": "...", "default": "..." }` — does it use `"en-US"` or `"default"`?
- The plan does not implement a locale resolver at all in Phase 1.0 (i18n deferred to later phases), but the `Localized` zod type admits arbitrary keys, so the absence of a fallback spec is a debt that must be paid before Phase 1.1 renders the catalog.

### 1.6. Atomic-write semantics on Windows network shares — underspecified

**Where:** Design spec §7.1 mentions "atomic write" for `installed.json`. Plan Part 3, Task 14 implements `atomicWriteJson` using `fs.promises.writeFile(tmp)` + `fs.promises.rename(tmp, dest)`.

**Gap:** On Windows, `rename` across network share boundaries (UNC paths, mapped drives) is NOT atomic — it may fall back to copy+delete, which can leave a torn file if the process crashes mid-copy. The spec and plan do not address this case. For the local `%APPDATA%` path (same volume), `rename` is atomic on NTFS. For IT-managed roaming profiles that redirect `%APPDATA%` to a UNC path, this guarantee breaks.

**Mitigation needed:** Document the guarantee scope (same-volume only) and add a runtime check in `atomicWriteJson` that verifies `tmp` and `dest` are on the same volume before relying on rename atomicity.

---

## 2. Risk Register for R1 Implementation

| Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|
| **Zip slip** via crafted `../` entry in `payload.zip` | Low (requires malicious payload) | Critical (arbitrary file write on host) | `checkEntryName` in `zip-safe.ts` already rejects `../` via `path.normalize`. **Verify:** test must cover entry `"../../../Windows/System32/evil.dll"` — current test only covers `"../escape.txt"`. Add deep relative path test. | R1-Reviewer-Engine |
| **Symlink in zip** (Unix-mode external attributes 0xA000) | Low | High (symlink to sensitive dir allows subsequent overwrites) | `extractZipSafe` checks `externalFileAttributes >>> 16 & 0xf000 === 0xa000`. **Gap:** yauzl may not populate `externalFileAttributes` for zips created on Windows (where the field is often 0). Add a test with a zip created with explicit Unix mode bits AND a zip from a Windows tool. | R1-Reviewer-Engine |
| **Journal corruption mid-rollback** | Low (crash during rollback) | High (partially-rolled-back state invisible to engine) | `recoverPending` in the plan detects leftover journal files. But if the journal file itself is half-written (crash during `journal-store.write`), zod parse returns `null` silently. **Need:** if journal file exists but fails parse, log a warn, quarantine the file (rename to `.corrupt`), and surface to the user — do not silently drop it. | R1-Reviewer-Foundation |
| **Signature timing attack** on Ed25519 verify | Very Low | Medium | `@noble/ed25519` uses constant-time scalar multiplication. No additional action needed for R1. Confirm version ≥ 2.x which has the constant-time guarantee. Document in security review. | R1-Verify |
| **Registry write reentrancy** (two `runInstall` calls for the same app in the same process) | Low | High (registry inverse incorrectly records `overwritten = {}` because the value was already set by the first call) | `acquireAppLock` is NOT called from `runInstall` in the plan. Wire `acquireAppLock` into `runInstall` and `runUninstall` before any state mutation. | R1-Reviewer-Engine |
| **Atomic-write torn writes** on network-redirected `%APPDATA%` | Medium (corporate environments) | High (corrupt `installed.json` breaks future launches) | `rename` is NOT atomic cross-volume on Windows. Add volume-check guard in `atomicWriteJson`. On failure, log error and write in-place (non-atomic) with an explicit warning. | R1-Reviewer-Foundation |
| **macOS-via-mock divergence** in path normalization | High (runs in all CI) | Medium (false passes that hide Windows-specific bugs) | See §4 for full list. Critical items: `path.posix.normalize` vs `path.win32.normalize` in `zip-safe.ts` — the plan uses `posix.normalize` which normalizes `\` as a literal character on posix, not as a separator. A Windows path like `subdir\file.txt` would NOT be flagged as zip slip by the posix normalizer. | R1-Tester-Infrastructure |
| **Ed25519 small-subgroup attack** via degenerate public key | Very Low | Medium | `@noble/ed25519` v2.x validates points on `verify`; passing a low-order point returns false rather than throwing. Add a test: `verifySignature` with a known low-order public key returns `false`. | R1-Reviewer-Engine |
| **Payload streaming OOM** if `fetchPayload` yields without backpressure | Low in R1 (not yet networked) | High in R2 (large payloads fully buffered) | `vdxpkg.ts` reads the entire payload into memory via `readFile`. For production (R2), `payload-downloader.ts` must stream to disk using `AsyncIterable<Uint8Array>` chunks; never buffer full payload in main process. Document this constraint in the `PackageSource` interface (already done in the abstraction spec). | R2-Reviewer |
| **Lock-file stale ownership detection** after process crash | Medium | Medium (app permanently locked after crash) | The plan's lock uses `wx` (exclusive create). On crash, the lock file is not deleted. There is no PID-liveness check. On next launch, the engine will refuse to install any app that was mid-install when it crashed. **Need:** `acquireAppLock` must check if the PID in the lockfile is still alive before returning `err`; if stale, remove the lockfile and proceed. | R1-Reviewer-Foundation |

---

## 3. Test Coverage Gaps

### 3.1. Chunked download resume — not tested

**Test plan coverage:** E6 ("Network drop mid-download → resume completes") is listed for Phase 2. But `zip-safe.ts` and `payload-hash.ts` are already in R1, and the `ByteRange` type in the new `PackageSource` spec is also R1 material.

**Gap:** No test verifies that extracting from a partial download (bytes 0–N fetched, then N+1 to end fetched separately and concatenated) produces the same result as a single fetch. When `LocalFsSource` is backed by memfs and supports Range, this scenario is fully testable in R1.

**Missing test:** `test/source/local-fs-resume.test.ts`:
- Write a payload.zip to memfs.
- Call `fetchPayload` for bytes 0..K, then bytes K..total (using `ByteRange`).
- Concatenate and verify sha256 matches manifest.

### 3.2. `installed.json.bak` fallback path — not tested

**Test plan coverage:** `atomic-write.test.ts` verifies `.bak` is created. But no test exercises the scenario where `installed.json` is corrupt and the engine reads `.bak` to recover.

**Gap:** `readJsonOrDefault` returns the `defaultValue()` if the file is missing or unreadable. It does NOT attempt to read `.bak`. If `installed.json` is corrupt (partial write), the engine would re-initialize from an empty state — losing all install records. This is a data-loss scenario.

**Missing behavior:** `readJsonOrDefault` (or `InstalledStore.read`) should attempt `.bak` before returning the default.

**Missing test:** Write valid JSON to `.bak`, write invalid JSON to the primary file, call `store.read()`, assert it returns the `.bak` contents.

### 3.3. `.vdxpkg` with malformed central directory — not tested

**Test plan coverage:** `vdxpkg.test.ts` covers missing required entries and sha256 mismatch. No test covers a zip with a corrupt central directory.

**Gap:** yauzl's behavior on a zip with a truncated or XORed central directory is: throw an error from `fromBuffer`. The `parseVdxpkg` try/catch around `extractZipSafe` should catch this and return `err(...)`, but this is not tested. If yauzl throws an unclassified Error rather than a ZipError, it might escape the try/catch if the catch is too narrow.

**Missing test:** Feed `parseVdxpkg` a buffer that starts with `PK` magic bytes but has a randomly corrupted central directory. Assert `result.ok === false` with a message matching `/extract/i`.

### 3.4. Concurrent install of same app from two host instances — not tested

**Test plan coverage:** E16 ("Concurrent install of two apps") is listed for Phase 1.1 E2E. But the lock mechanism is in R1, and "same app from two processes" is more dangerous than "two different apps."

**Gap:** No R1 engine test verifies that two `acquireAppLock` calls for the same `appId` fail correctly when using real filesystem semantics (not just mock). The `MockPlatform` uses memfs which uses in-process JS `Map` — it does NOT use `fs.promises.open` with `wx` flag (which is where OS-level exclusivity is enforced). The lock test in Part 4, Task 25 uses memfs and may not catch bugs in the real `node:fs` path.

**Missing test:** A test using `tmpdir()` (real OS filesystem) that spawns two async `acquireAppLock` calls and asserts one succeeds and one fails.

### 3.5. Post-install action partial failure → rollback ordering — not tested

**Test plan coverage:** `install.test.ts` covers "rollback when shortcut fails" (pre-existing shortcut path). But it only covers the first action failing. The rollback ordering when the Nth action (out of M) fails is not tested.

**Gap:** The `install.ts` plan accumulates inverses in `inverseHandlers[]` and iterates in reverse on error. If action #2 of 4 fails, inverses for actions #1 and #2 should be rolled back, but #3 and #4 were never applied (so no inverse is needed). The current code is correct but this invariant is not tested.

**Missing test:** Manifest with 3 post-install actions; the second one is sabotaged. Assert:
- Action #1 inverse is called (shortcut deleted).
- Action #3 inverse is NOT called (it was never applied).
- ARP is not present (never registered because failure happened before ARP step).

---

## 4. Cross-Platform Mock Fidelity

The following items represent places where macOS (or Linux) running the `MockPlatform` + memfs will NOT behave the same as real Windows. Each is a potential source of false-passing tests.

### 4.1. CRLF vs LF in manifest JSON files

- Windows text editors and tools often write `\r\n`. If a manifest is created on Windows and stored in the test fixture as a UTF-8 file with CRLF, `JSON.parse` handles it fine. But Ed25519 signature verification is over the **exact bytes** of the manifest. If the manifest is signed on Linux (LF) but the test fixture was saved on Windows (CRLF), the signature test will fail on real Windows if the manifest bytes differ.
- **Platform interface must model:** document that all manifests are canonically LF, and that `vdx-pack` CLI enforces LF before signing.

### 4.2. Windows path normalization

- `path.posix.normalize("sub/../../evil")` returns `"../evil"` (caught by zip slip guard).
- `path.win32.normalize("sub\\..\\..\\evil")` returns `"..\evil"` (also caught).
- **BUT:** `path.posix.normalize("sub\\evil")` returns `"sub\\evil"` (backslash is a literal filename character on POSIX). A zip entry named `"subdir\file.txt"` on Windows creates a single file with a backslash in the name; on macOS it creates a file named literally `subdir\file.txt`. The `checkEntryName` function in `zip-safe.ts` uses `path.posix.normalize` but zip entries from Windows tools may contain backslashes as separators.
- **Fix needed:** `checkEntryName` must also normalize backslashes to forward slashes before applying the zip-slip check.

### 4.3. Registry key case-insensitivity

- Real Windows registry is case-insensitive: `HKCU\Software\Samsung` and `HKCU\software\samsung` refer to the same key.
- `MockPlatform.regKey` normalizes to lowercase: `regKey = \`${hive}::${key.replace(/\\/g, '\\').toLowerCase()}\``. This is correct behavior for the mock.
- **Risk:** If the Windows platform implementation in Phase 1.1 does NOT normalize case, and a manifest writes to `HKCU\Software\Samsung\X` but the inverse reads `HKCU\software\samsung\x`, the inverse fails to find the value on real Windows but passes in the mock.
- **Requirement:** Document in `Platform` interface that `registryRead`/`registryWrite`/`registryDeleteValue` implementations must be case-insensitive on key paths (by lowercasing internally or by relying on the OS).

### 4.4. ARP key naming

- The ARP key is `Software\Microsoft\Windows\CurrentVersion\Uninstall\${manifest.id}`.
- App IDs use reverse-DNS notation with dots: `com.samsung.vdx.exampleapp`. On real Windows, this key name with dots is valid and common. In the mock, it works fine.
- **Risk:** Real Windows has an undocumented limit where ARP registry key names > 128 characters may be silently truncated or cause unpredictable behavior. App IDs approaching this length (unlikely but possible) could break ARP registration on real Windows while the mock passes.

### 4.5. Junction vs symlink

- The zip-slip guard rejects symlinks via Unix mode bits in external file attributes. Windows tools create "junctions" (a Windows-specific type) which are NOT represented as symlinks in the Unix mode field.
- A zip created by a malicious Windows tool could include a junction entry that passes the symlink check (`fileType !== 0xa000`) but creates a junction on Windows, redirecting extraction to an arbitrary path.
- **Fix needed in R1:** Also check for Windows-specific reparse point flags in the internal file attributes. This is advanced; the minimum mitigation is to document that `payload.zip` MUST be created by `vdx-pack` CLI which forbids junctions.

### 4.6. `%LOCALAPPDATA%` vs roaming `%APPDATA%`

- The plan uses `%APPDATA%` (roaming) for `installed.json`. On Windows, roaming profiles sync across machines in domain environments. If a user installs an app on machine A, `installed.json` roams to machine B. But the app files are at `%LocalAppData%\Programs\Samsung\...` which does NOT roam.
- Result: machine B's `installed.json` shows an app as "Installed" at a path that does not exist.
- **Gap:** The design spec and plans do not address this. The `MockPlatform` treats `%APPDATA%` and `%LocalAppData%` as both local paths — this divergence is invisible in tests.
- **Mitigation:** Consider moving `installed.json` to `%LocalAppData%\vdx-installer\` or add a startup check that verifies each app's `installPath` exists.

### 4.7. SID resolution (machine-scope installs)

- Machine-scope installs write to `HKLM`. On real Windows, `HKLM` writes require elevation. The `MockPlatform` allows `HKLM` writes unconditionally (no elevation check).
- **Risk:** Engine tests for machine-scope install pass on macOS but would fail at runtime on Windows without elevation. There is no test that verifies machine-scope installs route to the elevated worker.
- **Requirement:** `Platform.registryWrite` for `HKLM` hive on the Windows implementation must check that the process is elevated (or throw a specific error). The mock should be parameterizable: `MockPlatform({ elevationGranted: false })` should cause HKLM writes to throw `PermissionError`.

---

## 5. Concrete Recommendations for R1 (Numbered, Actionable)

**Reviewers must implement or guard against each item.**

1. **Wire `acquireAppLock` into `runInstall` and `runUninstall`.**
   In `src/main/engine/install.ts`, call `acquireAppLock(lockDir, appId, platform.fs)` as the very first step before opening a transaction. Return `err("App is already being installed: {appId}")` immediately if the lock fails. Call `lock.release()` in `finally`. Do the same in `uninstall.ts`. Without this, two concurrent installs will corrupt the journal.

2. **Add stale-lock detection to `acquireAppLock`.**
   In `src/main/state/lock.ts`, before returning `err("Lock busy")`, read the lockfile and parse `pid=<N>`. On Windows, check if process `N` is still alive via `platform.isProcessRunning`. If not alive, delete the stale lockfile and proceed with acquisition. Log a `warn` that a stale lock was recovered.

3. **`atomicWriteJson` must handle cross-volume rename failure gracefully.**
   In `src/main/state/atomic-write.ts`, catch `EXDEV` (cross-device link) from `rename` and fall back to a manual copy+delete. Emit a `warn` log: "atomic rename not possible on this filesystem; falling back to copy+delete". Document the degraded guarantee.

4. **`installed.json.bak` must be used as a recovery path.**
   In `src/main/state/installed-store.ts`, `read()` must try `installed.json.bak` if `installed.json` fails to parse (zod error or JSON syntax error). Priority: `installed.json` (valid) → `installed.json.bak` (valid) → `defaultValue()`. Each fallback must emit a `warn` log. Add a test for this path.

5. **`zip-safe.ts` must normalize backslashes before zip-slip check.**
   In `checkEntryName`, add: `const normalized = path.posix.normalize(name.replace(/\\/g, '/'))` and use `normalized` for all subsequent checks. Add a test for a zip entry with name `"subdir\\file.txt"` (backslash separator) — must NOT be rejected as zip slip, but must be extracted as `subdir/file.txt`.

6. **Journal schema must include `stepOrdinal` and `inverseOpType`.**
   In `src/shared/schema/journal.ts`, add `stepOrdinal: z.number().int().nonnegative()` to every `JournalEntry` variant. In `transaction.ts`, set `stepOrdinal` to `file.steps.length` before appending. Rollback MUST iterate `[...file.steps].sort((a,b) => b.stepOrdinal - a.stepOrdinal)` (descending) rather than relying on array order, which can be corrupted if a partial journal write left a step in the wrong position.

7. **`exec` journal entry must record `timedOut: boolean`.**
   Add `timedOut: z.boolean()` to the `exec` variant of `JournalEntry` in `src/shared/schema/journal.ts`. In `exec.ts`, set `timedOut: result.timedOut`. Rollback code can then distinguish a timeout (process may still be running) from a clean non-zero exit. On timeout rollback, the engine should attempt `TerminateProcess` on the spawned PID (Windows platform impl concern, Phase 1.1).

8. **`verifySignature` must test against a known low-order Ed25519 public key.**
   Add to `test/engine/signature.test.ts`: a test using a 32-byte all-zeros public key (a known low-order point) and verify that `verifySignature` returns `false` without throwing. This confirms `@noble/ed25519` v2.x rejects degenerate keys. If the current version allows them, upgrade before R1 ships.

9. **`parseVdxpkg` must have a test for corrupt central directory.**
   Add to `test/engine/vdxpkg.test.ts`: a test where the input buffer is `Buffer.alloc(64).fill(0x50, 0, 2)` (starts with `PK` then zeros). Assert that `parseVdxpkg` returns `err(...)` and does NOT throw an unhandled exception. Add a try/catch around the `extractZipSafe` call in `parseVdxpkg` that catches ALL errors (not just known types) and wraps them in `err(...)`.

10. **`MockPlatform` must support `elevationGranted` option.**
    Add `elevationGranted?: boolean` to `MockPlatformOptions`. When `false` (default for user-scope tests), `registryWrite` and `registryDeleteKey` on `HKLM` hive should throw `new Error("HKLM write requires elevation")`. All machine-scope install tests must explicitly pass `{ elevationGranted: true }`. This catches bugs where the engine attempts HKLM writes without routing to the elevated worker.

11. **Add a grep-gate CI check for hardcoded repo strings.**
    In `package.json` scripts, add: `"check:no-hardcoded-source": "grep -r 'samsung/vdx-catalog\\|api.github.com\\|samsung/vdx-installer' src/ --include='*.ts' --exclude='config-defaults.ts' && exit 1 || exit 0"`. Run this in the `typecheck` step. Any hardcoded source reference outside `config-defaults.ts` fails CI.

12. **`when` expression precedence must be documented in the design spec.**
    The Reviewer for the spec extension (`2026-05-01-package-source-abstraction.md`) should also file a note that `when` expression precedence (`!` > `==`/`!=` > `&&` > `||`) be added as an appendix to the main design spec. App team developers writing manifests need this information. This is a documentation action, not a code action, but it must be tracked.
