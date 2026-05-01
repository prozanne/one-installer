# VDX Installer — Test Plan

**Companion to:** Phase 1.0 implementation plan (Parts 1-4) and the design spec.

---

## 1. Test Pyramid

```
                  E2E (Playwright + Electron, Windows runner)
              ┌────────────────────────────┐
              │  ~20 scenarios — Phase 1.1+│
              └────────────────────────────┘
        Engine integration (vitest + memfs + MockPlatform)
    ┌──────────────────────────────────────────────────┐
    │  ~50 scenarios — Phase 1.0 in this plan          │
    └──────────────────────────────────────────────────┘
              Unit (vitest)
   ┌────────────────────────────────────────────────────────┐
   │  schemas, parsers, journal, redact, atomic write, …     │
   │  ~150+ cases — Phase 1.0 in this plan                   │
   └────────────────────────────────────────────────────────┘
```

The test plan in this document focuses on **what we test** and **the matrix of scenarios** we want covered. The implementation plan tells you *how* to write each individual test.

---

## 2. Phase 1.0 (engine core) — Test inventory

### 2.1. Schemas (`test/shared/schema/`)

| Suite | Cases |
|---|---|
| `manifest.test.ts` | accepts minimal · rejects bad id · rejects bad version · accepts all 6 wizard step types · accepts all 4 post-install actions · rejects exec without hashes · rejects exec timeout above max · rejects last step ≠ summary |
| `installed-state.test.ts` | accepts default-shaped state · rejects bad schema version · round-trips |
| `journal.test.ts` | accepts each entry type · rejects unknown type · accepts each transaction status |
| `catalog.test.ts` | accepts minimal · rejects bad channel value |

### 2.2. Engine — pure logic

| Suite | Cases |
|---|---|
| `template.test.ts` | substitutes user var · nested · system var · throws on undefined · multi-substitute · `resolveVariables` lists refs |
| `when-expr.test.ts` | single var · ==/!= · &&/\|\| · ! · parens · empty/undefined → true · rejects forbidden syntax (semicolons, function calls, +) |
| `wizard.test.ts` | validate license/path/text/select/checkboxGroup · reject required-missing · reject regex-fail · reject empty path |
| `wizard-reuse.test.ts` | reuse all when unchanged · ask only new step · ask changed-type step · `canSkipWizard` true when no must-ask |
| `validate.test.ts` | passes minimal · rejects extract-from missing in payload · rejects unknown var · rejects exec outside installPath · rejects bad when expr · rejects scope.default not in supports |

### 2.3. Engine — IO + platform

| Suite | Cases |
|---|---|
| `platform-mock.test.ts` | fs writes/reads · sha256 deterministic · registry round-trip |
| `zip-safe.test.ts` | extract plain · reject zip slip · reject absolute path · reject reserved name · reject symlink · `listZipEntries` does not extract |
| `signature.test.ts` | accept valid · reject tampered · reject bad length |
| `vdxpkg.test.ts` | accept valid bundle · reject payload sha256 mismatch · reject missing file in bundle · sig invalid yields signatureValid: false |
| `atomic-write.test.ts` | tmp+rename · keeps `.bak` · `readJsonOrDefault` returns default if missing |
| `journal-store.test.ts` | write/read/list/delete |
| `installed-store.test.ts` | initializes default · persists app · validates on read |
| `lock.test.ts` | first acquire ok · second acquire errors · release allows reacquire |
| `redact.test.ts` | masks ghp_ · masks home paths (mac+win) |

### 2.4. Engine — orchestration (the heart)

| Suite | Cases |
|---|---|
| `transaction.test.ts` | commit → journal file deleted · rollback replays inverses in reverse · `recoverPending` returns non-committed |
| `post-install/shortcut.test.ts` | apply creates `.lnk` · inverse deletes · idempotent on missing |
| `post-install/registry.test.ts` | apply writes values · inverse deletes only created · inverse restores overwritten |
| `post-install/env-path.test.ts` | apply adds · inverse removes · idempotent on missing |
| `post-install/arp.test.ts` | register writes ARP keys · deregister removes |
| `post-install/exec.test.ts` | rejects mismatched hash · accepts matching hash exit 0 · throws on non-zero exit · throws on timeout |
| `install.test.ts` | full happy path: extract + actions + ARP + commit · rollback when shortcut fails (pre-existing path) — verify pre-existing untouched, ARP not present, install dir cleaned |
| `uninstall.test.ts` | install then uninstall — verify shortcuts gone, env path gone, ARP gone, install dir gone |

### 2.5. Coverage targets

- `src/main/engine/**`: ≥ 85 % lines, ≥ 80 % branches.
- `src/main/state/**`: ≥ 85 % lines.
- `src/main/packages/**`: ≥ 80 % lines.
- `src/shared/**`: not coverage-targeted (mostly type definitions).

Run: `pnpm test:coverage`. CI fails if below targets.

---

## 3. Phase 1.1+ — E2E + integration scenarios (planning)

These scenarios are not implemented in Phase 1.0 (no Electron yet) but are listed here so the implementation plan for Phase 1.1 can reference them directly. Numbering matches design spec §17.3 for traceability.

| ID | Scenario | Phase | Layer |
|---|---|---|---|
| E1 | First-run flow (language → EULA → first catalog → tray prompt → catalog) | 1.1 | E2E |
| E2 | Sideload `.vdxpkg` via drag-drop → wizard → install → installed-list | 1.1 | E2E |
| E3 | Install machine-scope app (UAC mocked on CI; real on local) | 1.2 | E2E |
| E4 | Update with identical wizard (silent, no prompts) | 2 | E2E |
| E5 | Update with extended wizard (only new step asked) | 2 | E2E |
| E6 | Network drop mid-download → resume completes | 2 | Integration |
| E7 | Manifest signature failure → install rejected (dev mode off) | 2 | Integration |
| E8 | Payload hash mismatch → cache discarded, retry, then fail | 2 | Integration |
| E9 | exec action with wrong hash → install rolled back atomically | 1.0 | **Engine** |
| E10 | Crash mid-install (kill process) → restart → cleanup prompt → rollback | 1.1 | E2E |
| E11 | Sideload `.vdxpkg` (drag-drop) | 1.1 | E2E |
| E12 | Proxy via local proxy fixture | 2 | Integration |
| E13 | Catalog refresh failure → cached catalog used | 2 | E2E |
| E14 | Uninstall through host UI | 1.1 | E2E |
| E15 | Uninstall through Windows "Apps & features" (ARP UninstallString) | 1.1 | E2E (Windows-only) |
| E16 | Concurrent install of two apps | 1.1 | E2E |
| E17 | Self-update available, "Restart now" applies | 2 | E2E |
| E18 | App process running during update — close-or-skip modal | 1.1 | E2E |
| E19 | Manifest validator rejects missing payload reference | 1.0 | **Engine** |
| E20 | requiresReboot completion — pending file replaced after reboot | 1.1 | E2E (Windows) |
| E21 | Schema migration on host upgrade | 1.1 | Integration |
| E22 | Channel switch surfaces new versions | 2 | Integration |
| E23 | Diagnostics export contains expected redacted artifacts | 2 | E2E |
| E24 | EULA license step blocks until accepted | 1.1 | E2E |
| E25 | Disk-space pre-check blocks when free < 2× installed | 1.1 | Integration |

E9 and E19 are already covered in Phase 1.0 engine tests (`exec.test.ts`, `validate.test.ts`).

---

## 4. CI matrix

| Trigger | Job | Runner |
|---|---|---|
| PR open / push | typecheck + lint + unit + engine integration | ubuntu-latest |
| PR (touching `src/main/platform/windows.ts` or any UI) | E2E smoke (5 scenarios) | windows-latest |
| Push to `main` | full E2E + electron-builder build artifacts | windows-latest |
| Tag push (`v*`) | full E2E + signtool sign + GitHub Release | windows-latest |
| Nightly | full E2E + Windows Sandbox real-install scenarios | windows-latest |

GitHub Actions workflow names (Phase 1.1+):
- `.github/workflows/ci.yml` — PR / push
- `.github/workflows/release.yml` — tag push
- `.github/workflows/nightly.yml` — schedule

---

## 5. Manual test checklist (per release, Phase 1.1+)

Run on a clean Windows 10 22H2 + Windows 11 23H2 VM. Each must pass:

### 5.1. Install paths

- [ ] First launch creates `%APPDATA%\vdx-installer\` and `installed.json`.
- [ ] Per-user install lands in `%LocalAppData%\Programs\Samsung\<App>` by default.
- [ ] Machine install (when supported) lands in `C:\Program Files\Samsung\<App>` and triggers UAC exactly once.
- [ ] Path with Korean characters (`C:\사용자\bin`) installs successfully (or fails with clear validator error if manifest disallows).
- [ ] Path > 260 chars triggers long-path opt-in modal.

### 5.2. Wizard

- [ ] License step: blocks until "Accept" enabled (after scroll-to-bottom).
- [ ] Path step: writable check passes; non-writable path shows inline error.
- [ ] Text step: regex enforced; helpful error.
- [ ] Checkbox group: required item cannot be unchecked.
- [ ] Select: default option pre-selected.
- [ ] Summary: shows all answers; "Back" returns to last step.

### 5.3. Update behavior

- [ ] App auto-update with identical wizard: shows progress, no prompts.
- [ ] App update with new step: shows only the new step, other answers preserved.
- [ ] App running during update: close-or-skip modal, PID + exe name visible.
- [ ] Self-update: badge appears in header; "Restart now" applies; previous app installs survive.

### 5.4. Failure paths

- [ ] Force-close host mid-install: next launch prompts cleanup; rollback restores original state.
- [ ] Manifest signature failure: install blocked unless dev mode (and dev mode prompts strongly).
- [ ] Payload hash mismatch: visible error, retry succeeds when payload re-uploaded.
- [ ] exec wrong hash: install rolls back; pre-existing app state untouched.

### 5.5. System integration

- [ ] App appears in Windows "Apps & features" with correct DisplayName, Publisher, Version.
- [ ] Uninstall through "Apps & features" launches host with `--uninstall` and removes everything.
- [ ] Desktop / Start Menu shortcuts created and removed.
- [ ] PATH entries added for user / machine scope as configured; survive logoff/login.
- [ ] requiresReboot manifest: end-of-install screen prompts; reboot applies pending moves.

### 5.6. Diagnostics

- [ ] Export diagnostics produces ZIP at user-chosen path.
- [ ] ZIP contains logs, redacted installed.json, sanitized system info.
- [ ] No GitHub PAT, no full home paths visible in any file.

### 5.7. Network

- [ ] Catalog refresh succeeds direct.
- [ ] Catalog refresh succeeds through corporate HTTP proxy.
- [ ] Catalog refresh succeeds through authenticating proxy.
- [ ] Private repo access via GitHub PAT in keytar.
- [ ] Network drop mid-download resumes silently.

---

## 6. Test data fixtures

### 6.1. Manifests

- `test/fixtures/manifests/minimal.json` — bare-minimum valid manifest, single summary step.
- `test/fixtures/manifests/full.json` — every wizard step type + every action type.
- `test/fixtures/manifests/invalid-bad-id.json` — bad `id` format.
- `test/fixtures/manifests/invalid-no-exec-hash.json` — exec without `allowedHashes`.
- `test/fixtures/manifests/invalid-zip-slip.json` — extract-from `../escape`.

### 6.2. Payloads

- `test/fixtures/payloads/minimal/x.exe` — synthetic 1 KB binary.
- `test/fixtures/payloads/full/...` — multiple files exercising globs.

### 6.3. Keys

- `test/fixtures/keys/dev-pub.bin` — checked-in (24-byte test public key).
- `test/fixtures/keys/dev-priv.bin` — gitignored; auto-generated by `getDevKeys()` test helper if missing.

A separate fixture for "wrong key" (`dev-pub-wrong.bin`) is used to test signature rejection.

---

## 7. What this plan does NOT cover

- Performance / load testing (catalog with 1,000+ apps, payload > 1 GB).
- Locale-specific behavior for non-Latin OS settings beyond Korean.
- Antivirus / EDR interaction tests (manual on real machines).
- Real Authenticode reputation / SmartScreen behavior (depends on cert age).
- IT mass-deployment scenarios (SCCM, Intune).

These are deferred to dedicated test plans alongside the relevant feature plans.

---

## 8. Test ownership & cadence

- **Engine unit + integration**: every PR, every commit. Fast (< 10 s on Mac for the engine suite).
- **E2E**: every PR if changes touch UI or platform; nightly otherwise.
- **Manual checklist**: before every tagged release.
- **Performance / scale**: before every major version (v1, v2).
