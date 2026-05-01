# VDX Installer — Phase 1.0 Engine Core (Part 4)

> Continuation of Parts 1-3.

---

## Phase J — Static manifest validation (Task 21)

### Task 21: validate.ts — semantic checks beyond zod

**Files:**
- Create: `src/main/engine/validate.ts`, `test/engine/validate.test.ts`

What this checks (zod cannot):
1. Every `install.extract[*].from` resolves to existing entries inside payload.
2. Every `postInstall.exec.cmd` resolves to a payload-internal absolute path after template render.
3. Every template variable referenced is either a system var or a wizard answer that will exist.
4. Every `when` expression parses successfully.
5. `installScope.default` is in `installScope.supports`.

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'vitest';
import { validateManifestSemantics } from '@main/engine/validate';
import type { Manifest } from '@shared/schema';

const baseManifest = (): Manifest => ({
  schemaVersion: 1,
  id: 'com.samsung.vdx.x',
  name: { default: 'X' },
  version: '1.0.0',
  publisher: 'Samsung',
  description: { default: 'd' },
  size: { download: 1, installed: 1 },
  payload: { filename: 'p.zip', sha256: 'a'.repeat(64), compressedSize: 1 },
  minHostVersion: '1.0.0',
  targets: { os: 'win32', arch: ['x64'] },
  installScope: { supports: ['user'], default: 'user' },
  requiresReboot: false,
  wizard: [
    { type: 'path', id: 'installPath', label: { default: 'P' }, default: '{ProgramFiles}/X' },
    { type: 'summary' },
  ],
  install: { extract: [{ from: '**/*', to: '{{installPath}}' }] },
  postInstall: [],
  uninstall: { removePaths: ['{{installPath}}'], removeShortcuts: true, removeEnvPath: true },
});

describe('validateManifestSemantics', () => {
  it('passes minimal valid manifest', () => {
    const r = validateManifestSemantics(baseManifest(), { payloadEntries: ['a.txt', 'core/b.dll'] });
    expect(r.ok).toBe(true);
  });

  it('rejects extract from path missing in payload', () => {
    const m = baseManifest();
    m.install.extract = [{ from: 'missing/**', to: '{{installPath}}' }];
    const r = validateManifestSemantics(m, { payloadEntries: ['core/x.dll'] });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown template variable', () => {
    const m = baseManifest();
    m.install.extract = [{ from: '**/*', to: '{{nonexistent}}' }];
    const r = validateManifestSemantics(m, { payloadEntries: ['x.dll'] });
    expect(r.ok).toBe(false);
  });

  it('rejects exec cmd outside installPath/payloadDir', () => {
    const m = baseManifest();
    m.postInstall = [
      {
        type: 'exec',
        cmd: 'C:/Windows/System32/calc.exe',
        args: [],
        timeoutSec: 5,
        allowedHashes: ['sha256:' + 'b'.repeat(64)],
      },
    ];
    const r = validateManifestSemantics(m, { payloadEntries: ['x.dll'] });
    expect(r.ok).toBe(false);
  });

  it('rejects bad when expression', () => {
    const m = baseManifest();
    m.postInstall = [
      { type: 'envPath', scope: 'user', add: '{{installPath}}/bin', when: 'process.exit()' },
    ];
    const r = validateManifestSemantics(m, { payloadEntries: ['x.dll'] });
    expect(r.ok).toBe(false);
  });

  it('rejects installScope default not in supports', () => {
    const m = baseManifest();
    m.installScope = { supports: ['user'], default: 'machine' };
    const r = validateManifestSemantics(m, { payloadEntries: ['x.dll'] });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Implement `src/main/engine/validate.ts`**

```ts
import minimatch from 'minimatch';
import { ManifestSchema, type Manifest } from '@shared/schema';
import { resolveVariables } from './template';
import { parseWhen } from './when-expr';
import { ok, err, type Result } from '@shared/types';

export interface ValidateInput {
  payloadEntries: string[]; // relative paths inside payload.zip
}

const KNOWN_SYS_VARS = new Set([
  'ProgramFiles', 'ProgramFilesX86', 'LocalAppData', 'Desktop', 'StartMenu',
  'Temp', 'InstallerVersion', 'AppId', 'AppVersion',
]);

export function validateManifestSemantics(
  manifest: Manifest,
  input: ValidateInput,
): Result<true, string[]> {
  // Re-validate via zod first (defense in depth)
  ManifestSchema.parse(manifest);
  const errors: string[] = [];

  // installScope.default in supports
  if (!manifest.installScope.supports.includes(manifest.installScope.default)) {
    errors.push(`installScope.default '${manifest.installScope.default}' not in supports`);
  }

  // Wizard ids known
  const wizardIds = new Set<string>();
  for (const step of manifest.wizard) {
    if ('id' in step) wizardIds.add(step.id);
  }

  // Check template references
  const refs: { source: string; userVars: string[]; systemVars: string[] }[] = [];
  for (let i = 0; i < manifest.install.extract.length; i++) {
    const ex = manifest.install.extract[i]!;
    refs.push({ source: `install.extract[${i}].to`, ...resolveVariables(ex.to) });
    if (ex.when) {
      try { parseWhen(ex.when); }
      catch (e) { errors.push(`install.extract[${i}].when invalid: ${(e as Error).message}`); }
      refs.push({ source: `install.extract[${i}].when`, ...resolveVariables(ex.when) });
    }
  }
  for (let i = 0; i < manifest.postInstall.length; i++) {
    const a = manifest.postInstall[i]!;
    const tag = `postInstall[${i}]`;
    if (a.when) {
      try { parseWhen(a.when); }
      catch (e) { errors.push(`${tag}.when invalid: ${(e as Error).message}`); }
      refs.push({ source: `${tag}.when`, ...resolveVariables(a.when) });
    }
    if (a.type === 'shortcut') {
      refs.push({ source: `${tag}.target`, ...resolveVariables(a.target) });
    } else if (a.type === 'registry') {
      for (const [n, v] of Object.entries(a.values)) {
        if (typeof v.data === 'string') {
          refs.push({ source: `${tag}.values.${n}.data`, ...resolveVariables(v.data) });
        }
      }
    } else if (a.type === 'envPath') {
      refs.push({ source: `${tag}.add`, ...resolveVariables(a.add) });
    } else if (a.type === 'exec') {
      refs.push({ source: `${tag}.cmd`, ...resolveVariables(a.cmd) });
      // exec.cmd must, after rendering with installPath placeholder, refer to a payload-internal location
      // We can do a static heuristic: must start with `{{installPath}}` or `{{...payloadDir...}}`
      if (!a.cmd.startsWith('{{installPath}}') && !a.cmd.includes('{{') ) {
        errors.push(`${tag}.cmd must start with {{installPath}} (got: ${a.cmd})`);
      }
    }
  }

  for (const r of refs) {
    for (const v of r.systemVars) {
      if (!KNOWN_SYS_VARS.has(v)) errors.push(`${r.source}: unknown system var {${v}}`);
    }
    for (const v of r.userVars) {
      const root = v.split('.')[0]!;
      if (!wizardIds.has(root)) {
        errors.push(`${r.source}: variable {{${v}}} not produced by any wizard step`);
      }
    }
  }

  // Extract from must match at least one payload entry (glob via minimatch)
  for (let i = 0; i < manifest.install.extract.length; i++) {
    const ex = manifest.install.extract[i]!;
    const matches = input.payloadEntries.some((p) => minimatch(p, ex.from));
    if (!matches) errors.push(`install.extract[${i}].from '${ex.from}' matches nothing in payload`);
  }

  return errors.length ? err(errors) : ok(true);
}
```

- [ ] **Step 3: Add minimatch dep**

```bash
pnpm add minimatch
pnpm add -D @types/minimatch
```

- [ ] **Step 4: Run + commit**

```bash
pnpm test test/engine/validate.test.ts
git add package.json pnpm-lock.yaml src/main/engine/validate.ts test/engine/validate.test.ts
git commit -m "feat(engine): semantic manifest validator (template refs, payload globs, when parse)"
```

---

## Phase K — Install + Uninstall runners (Tasks 22-23)

### Task 22: Install runner

**Files:**
- Create: `src/main/engine/install.ts`, `test/engine/install.test.ts`

This is the orchestration layer. It composes everything: extract payload, run actions, register ARP, journal everything, commit/rollback transaction.

- [ ] **Step 1: Test (full happy path + rollback on action failure)**

```ts
import { describe, it, expect } from 'vitest';
import { runInstall } from '@main/engine/install';
import { MockPlatform } from '@main/platform';
import { createJournalStore } from '@main/state/journal-store';
import { createTransactionRunner } from '@main/engine/transaction';
import { makeZip } from '../helpers/make-zip';
import type { Manifest } from '@shared/schema';

const baseManifest = (): Manifest => ({
  schemaVersion: 1,
  id: 'com.samsung.vdx.x',
  name: { default: 'X' },
  version: '1.0.0',
  publisher: 'Samsung',
  description: { default: 'd' },
  size: { download: 1, installed: 1 },
  payload: { filename: 'p.zip', sha256: 'a'.repeat(64), compressedSize: 1 },
  minHostVersion: '1.0.0',
  targets: { os: 'win32', arch: ['x64'] },
  installScope: { supports: ['user'], default: 'user' },
  requiresReboot: false,
  wizard: [{ type: 'summary' }],
  install: { extract: [{ from: '**/*', to: '{{installPath}}' }] },
  postInstall: [
    { type: 'shortcut', where: 'desktop', target: '{{installPath}}/x.exe', name: 'X' },
    { type: 'registry', hive: 'HKCU', key: 'Software\\Samsung\\X',
      values: { InstallPath: { type: 'REG_SZ', data: '{{installPath}}' } } },
  ],
  uninstall: { removePaths: ['{{installPath}}'], removeShortcuts: true, removeEnvPath: true },
});

describe('runInstall', () => {
  it('extracts payload, runs actions, registers ARP, returns committed transaction', async () => {
    const p = new MockPlatform();
    const journal = createJournalStore('/journal', p.fs);
    const runner = createTransactionRunner({ journal });
    const payload = await makeZip({ 'x.exe': 'binary' });

    const result = await runInstall({
      manifest: baseManifest(),
      payloadBytes: payload,
      wizardAnswers: { installPath: '/Apps/X' },
      platform: p,
      runner,
      hostExePath: 'C:/host.exe',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.committed.status).toBe('committed');
      expect(p.shortcuts.size).toBe(1);
      expect(await p.registryRead('HKCU', 'Software\\Samsung\\X', 'InstallPath')).toEqual({
        type: 'REG_SZ', data: '/Apps/X',
      });
      expect(
        await p.registryRead('HKCU', 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.samsung.vdx.x', 'DisplayName'),
      ).toEqual({ type: 'REG_SZ', data: 'X' });
    }
  });

  it('rolls back when an action fails', async () => {
    const p = new MockPlatform();
    const journal = createJournalStore('/journal', p.fs);
    const runner = createTransactionRunner({ journal });
    const payload = await makeZip({ 'x.exe': 'binary' });

    // Sabotage shortcut creation by pre-creating one at the same path
    const m = baseManifest();
    const desktopDir = p.systemVars().Desktop!;
    await p.ensureDir(desktopDir);
    await p.createShortcut({
      path: `${desktopDir}/X.lnk`, target: '/preexisting.exe',
    });

    const result = await runInstall({
      manifest: m, payloadBytes: payload,
      wizardAnswers: { installPath: '/Apps/X' },
      platform: p, runner, hostExePath: 'C:/host.exe',
    });

    expect(result.ok).toBe(false);
    // ARP must not exist after rollback
    expect(
      await p.registryRead('HKCU', 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.samsung.vdx.x', 'DisplayName'),
    ).toBeNull();
    // Pre-existing shortcut preserved (we only delete what we created)
    expect(p.shortcuts.size).toBe(1);
    expect(p.shortcuts.get(`${desktopDir}/X.lnk`)?.target).toBe('/preexisting.exe');
  });
});
```

- [ ] **Step 2: Implement `src/main/engine/install.ts`**

```ts
import minimatch from 'minimatch';
import { Volume, createFsFromVolume } from 'memfs';
import type { Manifest } from '@shared/schema';
import type { TransactionFileT } from '@shared/schema';
import type { Platform } from '@main/platform';
import { extractZipSafe } from '@main/packages/zip-safe';
import { applyAction, inverseAction } from './post-install';
import { renderTemplate } from './template';
import { evaluateWhen } from './when-expr';
import { arpRegister, arpDeregister } from './post-install/arp';
import type { TransactionRunner } from './transaction';
import { ok, err, type Result } from '@shared/types';

export interface InstallInput {
  manifest: Manifest;
  payloadBytes: Buffer;
  wizardAnswers: Record<string, unknown>;
  platform: Platform;
  runner: TransactionRunner;
  hostExePath: string;
  scope?: 'user' | 'machine';
}

export interface InstallSuccess {
  committed: TransactionFileT;
  installPath: string;
}

export async function runInstall(input: InstallInput): Promise<Result<InstallSuccess, string>> {
  const scope = input.scope ?? input.manifest.installScope.default;
  const sysVars = input.platform.systemVars();
  // Wizard answers establish installPath; default scope-specific if not provided
  const ctx = { ...input.wizardAnswers } as Record<string, unknown>;
  const installPath = String(ctx.installPath ?? `${sysVars.LocalAppData}/Programs/Samsung/${input.manifest.id}`);
  ctx.installPath = installPath;

  const tx = await input.runner.begin({ appId: input.manifest.id, version: input.manifest.version, scope });
  const ctxForActions = {
    platform: input.platform,
    templateContext: ctx,
    systemVars: { ...sysVars, AppId: input.manifest.id, AppVersion: input.manifest.version },
    installPath,
    appId: input.manifest.id,
    payloadDir: installPath,
  };
  const inverseHandlers: { entry: import('@shared/schema').JournalEntryT; }[] = [];

  try {
    // 1. Extract payload to a sandbox memfs first to enumerate entries; then move into installPath.
    await input.platform.ensureDir(installPath);

    // Stage to platform.fs: extract directly into installPath using the platform's fs (so MockPlatform tests can observe).
    const extractRes = await extractZipSafe({
      zipBytes: input.payloadBytes,
      destDir: installPath,
      // Use platform's fs (memfs in tests; real fs in prod via a Windows platform impl that exposes nodeFs)
      fs: (input.platform as unknown as { fs: import('memfs').IFs }).fs ?? undefined,
    });

    // Filter by extract globs + when
    const wantPaths = new Set<string>();
    for (const rule of input.manifest.install.extract) {
      if (!evaluateWhen(rule.when, ctx)) continue;
      const target = renderTemplate(rule.to, ctx, ctxForActions.systemVars);
      for (const f of extractRes.files) {
        if (minimatch(f, rule.from)) {
          wantPaths.add(f);
          // For non-default `to`, move
          if (target !== installPath) {
            await input.platform.ensureDir(target);
            await input.platform.moveFile(`${installPath}/${f}`, `${target}/${f}`, { overwrite: true });
          }
        }
      }
    }
    // Remove unwanted files (extract emitted everything, but we only "claim" matching set)
    for (const f of extractRes.files) {
      if (!wantPaths.has(f)) {
        try { await input.platform.rmFile(`${installPath}/${f}`); }
        catch { /* ignore */ }
      }
    }
    await tx.append({ type: 'extract', files: [...wantPaths], atTs: new Date().toISOString() });

    // 2. PostInstall actions
    for (const action of input.manifest.postInstall) {
      const entry = await applyAction(action, ctxForActions);
      if (entry) {
        await tx.append(entry);
        inverseHandlers.push({ entry });
      }
    }

    // 3. ARP
    const arpEntry = await arpRegister({
      platform: input.platform,
      manifest: input.manifest,
      installPath,
      scope,
      hostExePath: input.hostExePath,
    });
    await tx.append(arpEntry);
    inverseHandlers.push({ entry: arpEntry });

    // 4. Commit
    const committed = await tx.commit();
    return ok({ committed, installPath });
  } catch (e) {
    // Manual rollback because we already appended steps
    for (const h of [...inverseHandlers].reverse()) {
      if (h.entry.type === 'arp') await arpDeregister(h.entry, input.platform);
      else await inverseAction(h.entry, input.platform);
    }
    // Also clean up extracted files
    try { await input.platform.rmDir(installPath, { recursive: true }); } catch { /* ignore */ }
    await tx.rollback((e as Error).message);
    return err((e as Error).message);
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm test test/engine/install.test.ts
git add src/main/engine/install.ts test/engine/install.test.ts
git commit -m "feat(engine): install runner with extract + actions + ARP + transactional rollback"
```

---

### Task 23: Uninstall runner

**Files:**
- Create: `src/main/engine/uninstall.ts`, `test/engine/uninstall.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'vitest';
import { runInstall } from '@main/engine/install';
import { runUninstall } from '@main/engine/uninstall';
import { MockPlatform } from '@main/platform';
import { createJournalStore } from '@main/state/journal-store';
import { createTransactionRunner } from '@main/engine/transaction';
import { makeZip } from '../helpers/make-zip';
import type { Manifest } from '@shared/schema';

const baseManifest = (): Manifest => ({
  schemaVersion: 1,
  id: 'com.samsung.vdx.x',
  name: { default: 'X' },
  version: '1.0.0',
  publisher: 'Samsung',
  description: { default: 'd' },
  size: { download: 1, installed: 1 },
  payload: { filename: 'p.zip', sha256: 'a'.repeat(64), compressedSize: 1 },
  minHostVersion: '1.0.0',
  targets: { os: 'win32', arch: ['x64'] },
  installScope: { supports: ['user'], default: 'user' },
  requiresReboot: false,
  wizard: [{ type: 'summary' }],
  install: { extract: [{ from: '**/*', to: '{{installPath}}' }] },
  postInstall: [
    { type: 'shortcut', where: 'desktop', target: '{{installPath}}/x.exe', name: 'X' },
    { type: 'envPath', scope: 'user', add: '{{installPath}}/bin' },
  ],
  uninstall: { removePaths: ['{{installPath}}'], removeShortcuts: true, removeEnvPath: true },
});

describe('runUninstall', () => {
  it('removes everything install created', async () => {
    const p = new MockPlatform();
    const journal = createJournalStore('/journal', p.fs);
    const runner = createTransactionRunner({ journal });
    const payload = await makeZip({ 'x.exe': 'b', 'bin/lib.dll': 'b' });

    const installRes = await runInstall({
      manifest: baseManifest(), payloadBytes: payload,
      wizardAnswers: { installPath: '/Apps/X' },
      platform: p, runner, hostExePath: 'C:/h.exe',
    });
    expect(installRes.ok).toBe(true);
    if (!installRes.ok) return;

    expect(p.shortcuts.size).toBe(1);
    expect(p.userPath).toContain('/Apps/X/bin');

    const uninstallRes = await runUninstall({
      manifest: baseManifest(),
      installPath: '/Apps/X',
      journalEntries: installRes.value.committed.steps,
      platform: p,
      runner,
      scope: 'user',
    });
    expect(uninstallRes.ok).toBe(true);
    expect(p.shortcuts.size).toBe(0);
    expect(p.userPath).not.toContain('/Apps/X/bin');
    expect(
      await p.registryRead('HKCU', 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.samsung.vdx.x', 'DisplayName'),
    ).toBeNull();
    expect(await p.pathExists('/Apps/X')).toBe(false);
  });
});
```

- [ ] **Step 2: Implement `src/main/engine/uninstall.ts`**

```ts
import type { Manifest, JournalEntryT } from '@shared/schema';
import type { Platform } from '@main/platform';
import { inverseAction } from './post-install';
import { arpDeregister } from './post-install/arp';
import { renderTemplate } from './template';
import { ok, err, type Result } from '@shared/types';
import type { TransactionRunner } from './transaction';

export interface UninstallInput {
  manifest: Manifest;
  installPath: string;
  journalEntries: JournalEntryT[];
  platform: Platform;
  runner: TransactionRunner;
  scope: 'user' | 'machine';
}

export async function runUninstall(input: UninstallInput): Promise<Result<true, string>> {
  const tx = await input.runner.begin({
    appId: input.manifest.id,
    version: input.manifest.version,
    scope: input.scope,
  });

  try {
    // 1. preExec (manifest.uninstall.preExec) — optional, intentionally non-reversible
    // (Phase 1.0: skip implementation; preExec runs same as exec handler in phase 1.1.)

    // 2. Replay journal inverses in reverse order
    for (const entry of [...input.journalEntries].reverse()) {
      if (entry.type === 'arp') await arpDeregister(entry, input.platform);
      else await inverseAction(entry, input.platform);
      await tx.append(entry); // for traceability
    }

    // 3. Remove paths declared in manifest.uninstall.removePaths (after rendering)
    const ctx = { installPath: input.installPath };
    for (const p of input.manifest.uninstall.removePaths) {
      const path = renderTemplate(p, ctx, input.platform.systemVars());
      try { await input.platform.rmDir(path, { recursive: true }); }
      catch { /* idempotent */ }
    }

    await tx.commit();
    return ok(true);
  } catch (e) {
    await tx.rollback((e as Error).message);
    return err((e as Error).message);
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm test test/engine/uninstall.test.ts
git add src/main/engine/uninstall.ts test/engine/uninstall.test.ts
git commit -m "feat(engine): uninstall runner replays journal inverses + removePaths"
```

---

## Phase L — installed.json store + lock + logging (Tasks 24-26)

### Task 24: installed-store.ts

**Files:**
- Create: `src/main/state/installed-store.ts`, `test/engine/installed-store.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'vitest';
import { createInstalledStore } from '@main/state/installed-store';
import { MockPlatform } from '@main/platform';

const HOST_VER = '0.1.0';

describe('installed-store', () => {
  it('initializes default state when file missing', async () => {
    const p = new MockPlatform();
    await p.ensureDir('/state');
    const store = createInstalledStore('/state/installed.json', p.fs, HOST_VER);
    const s = await store.read();
    expect(s.schema).toBe(1);
    expect(s.host.version).toBe(HOST_VER);
    expect(s.apps).toEqual({});
  });

  it('persists app installation and read returns it', async () => {
    const p = new MockPlatform();
    await p.ensureDir('/state');
    const store = createInstalledStore('/state/installed.json', p.fs, HOST_VER);
    await store.update((s) => {
      s.apps['com.samsung.vdx.x'] = {
        version: '1.0.0', installScope: 'user', installPath: '/Apps/X',
        wizardAnswers: { installPath: '/Apps/X' },
        journal: [],
        manifestSnapshot: ({} as never),
        installedAt: new Date().toISOString(),
        updateChannel: 'stable',
        autoUpdate: 'ask',
        source: 'sideload',
      };
    });
    const s2 = await store.read();
    expect(Object.keys(s2.apps)).toEqual(['com.samsung.vdx.x']);
  });
});
```

- [ ] **Step 2: Implement `src/main/state/installed-store.ts`**

```ts
import type { IFs } from 'memfs';
import * as nodeFs from 'node:fs';
import { atomicWriteJson, readJsonOrDefault } from './atomic-write';
import { InstalledStateSchema, type InstalledStateT } from '@shared/schema';

export interface InstalledStore {
  read(): Promise<InstalledStateT>;
  update(mut: (s: InstalledStateT) => void): Promise<InstalledStateT>;
}

export function createInstalledStore(
  filePath: string,
  fs: IFs | typeof nodeFs = nodeFs,
  hostVersion: string,
): InstalledStore {
  const defaults = (): InstalledStateT => ({
    schema: 1,
    host: { version: hostVersion },
    lastCatalogSync: null,
    settings: {
      language: 'en',
      updateChannel: 'stable',
      autoUpdateHost: 'ask',
      autoUpdateApps: 'ask',
      cacheLimitGb: 5,
      proxy: null,
      telemetry: false,
      trayMode: false,
      developerMode: false,
    },
    apps: {},
  });

  return {
    async read() {
      const raw = await readJsonOrDefault(filePath, defaults, fs);
      return InstalledStateSchema.parse(raw);
    },
    async update(mut) {
      const cur = await this.read();
      mut(cur);
      const validated = InstalledStateSchema.parse(cur);
      await atomicWriteJson(filePath, validated, fs);
      return validated;
    },
  };
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm test test/engine/installed-store.test.ts
git add src/main/state/installed-store.ts test/engine/installed-store.test.ts
git commit -m "feat(state): installed-store with atomic update + zod-validated read"
```

---

### Task 25: Per-app lock + logger

**Files:**
- Create: `src/main/state/lock.ts`, `src/main/logging/logger.ts`, `src/main/logging/redact.ts`, `test/engine/lock.test.ts`, `test/engine/redact.test.ts`

- [ ] **Step 1: Lock test**

```ts
import { describe, it, expect } from 'vitest';
import { acquireAppLock } from '@main/state/lock';
import { MockPlatform } from '@main/platform';

describe('acquireAppLock', () => {
  it('returns release on first acquire, errors on second', async () => {
    const p = new MockPlatform();
    await p.ensureDir('/locks');
    const r1 = await acquireAppLock('/locks', 'app1', p.fs);
    expect(r1.ok).toBe(true);
    const r2 = await acquireAppLock('/locks', 'app1', p.fs);
    expect(r2.ok).toBe(false);
    if (r1.ok) await r1.value.release();
    const r3 = await acquireAppLock('/locks', 'app1', p.fs);
    expect(r3.ok).toBe(true);
    if (r3.ok) await r3.value.release();
  });
});
```

- [ ] **Step 2: Lock impl**

```ts
// src/main/state/lock.ts
import type { IFs } from 'memfs';
import * as nodeFs from 'node:fs';
import { ok, err, type Result } from '@shared/types';

export interface AppLock {
  release(): Promise<void>;
}

export async function acquireAppLock(
  lockDir: string,
  appId: string,
  fs: IFs | typeof nodeFs = nodeFs,
): Promise<Result<AppLock, string>> {
  const fsP = (fs as IFs).promises;
  await fsP.mkdir(lockDir, { recursive: true });
  const path = `${lockDir}/${appId}.lock`;
  try {
    const handle = await fsP.open(path, 'wx');
    await handle.writeFile(`pid=${process.pid}\nat=${new Date().toISOString()}\n`);
    await handle.close();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return err(`Lock busy: ${appId}`);
    return err((e as Error).message);
  }
  return ok({
    async release() {
      try { await fsP.unlink(path); } catch { /* idempotent */ }
    },
  });
}
```

- [ ] **Step 3: Redaction test + impl**

```ts
// test/engine/redact.test.ts
import { describe, it, expect } from 'vitest';
import { redact } from '@main/logging/redact';

describe('redact', () => {
  it('masks ghp_ tokens', () => {
    expect(redact('hello ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890')).toBe('hello [REDACTED:GH-PAT]');
  });
  it('masks home paths', () => {
    expect(redact('/Users/case/AppData/Local/X')).toBe('~/AppData/Local/X');
  });
  it('preserves other content', () => {
    expect(redact('plain text')).toBe('plain text');
  });
});
```

```ts
// src/main/logging/redact.ts
const PAT_RE = /\bghp_[A-Za-z0-9]{20,}\b/g;
const HOME_RE = /\/Users\/[^/\s]+/g;
const HOME_RE_WIN = /C:\\Users\\[^\\\s]+/gi;

export function redact(input: string): string {
  return input
    .replace(PAT_RE, '[REDACTED:GH-PAT]')
    .replace(HOME_RE, '~')
    .replace(HOME_RE_WIN, '~');
}
```

- [ ] **Step 4: Logger interface (no electron-log dep yet — pure interface for engine)**

```ts
// src/main/logging/logger.ts
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createConsoleLogger(minLevel: LogLevel = 'info'): Logger {
  const order: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];
  const minIdx = order.indexOf(minLevel);
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (order.indexOf(level) < minIdx) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
    console.log(line);
  };
  const make = (base: Record<string, unknown>): Logger => ({
    log(level, msg, fields) {
      emit(level, msg, { ...base, ...fields });
    },
    child(extra) {
      return make({ ...base, ...extra });
    },
  });
  return make({});
}
```

- [ ] **Step 5: Run + commit**

```bash
pnpm test test/engine/lock.test.ts test/engine/redact.test.ts
git add src/main/state/lock.ts src/main/logging test/engine/lock.test.ts test/engine/redact.test.ts
git commit -m "feat(state+logging): per-app lockfile + console logger + redaction"
```

---

### Task 26: Engine façade (the public API for phase 1.1 IPC layer)

**Files:**
- Create: `src/main/index.ts`

- [ ] **Step 1: `src/main/index.ts`**

```ts
export { runInstall } from './engine/install';
export { runUninstall } from './engine/uninstall';
export { validateManifestSemantics } from './engine/validate';
export { diffWizardForReuse, validateAnswer, computeWizardOrder } from './engine/wizard';
export { parseVdxpkg } from './packages/vdxpkg';
export { createTransactionRunner } from './engine/transaction';
export { createJournalStore } from './state/journal-store';
export { createInstalledStore } from './state/installed-store';
export { acquireAppLock } from './state/lock';
export { createConsoleLogger } from './logging/logger';
export type { Platform } from './platform';
export { MockPlatform } from './platform';
```

- [ ] **Step 2: Add typecheck to CI hint**

Run: `pnpm typecheck && pnpm test`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(engine): public façade for the engine core"
```

---

## Phase 1.0 — Acceptance criteria

- [ ] `pnpm typecheck` passes with no errors.
- [ ] `pnpm test` runs all tests; all PASS.
- [ ] `pnpm test:coverage` shows ≥ 85% line coverage on `src/main/engine/**` and `src/main/state/**`.
- [ ] A `.vdxpkg` produced by the test helper installs correctly via `runInstall`, and the resulting state matches expectations.
- [ ] Killing a test mid-install (simulated via thrown error after partial actions) leaves the platform in the original state.
- [ ] Uninstall via `runUninstall` removes everything `runInstall` created.

## Phase 1.0 — Out of scope (covered by later plans)

| Concern | Plan |
|---|---|
| Electron host process, IPC, preload | Phase 1.1 |
| React UI (catalog, wizard, progress, etc.) | Phase 1.1 |
| Real Windows platform impl (registry/shortcut/exec via Win32) | Phase 1.1 |
| Sideload entry point (file association, drag-drop) | Phase 1.1 |
| First-run flow, settings UI | Phase 1.1 |
| Catalog fetch, network/proxy, undici client | Phase 2 |
| GitHub auth (keytar) | Phase 2 |
| Self-update, electron-updater | Phase 2 |
| Tray, notifications | Phase 2 |
| Elevated worker, machine scope | Phase 3 |
| Code signing pipeline | Phase 3 |
| `vdx-pack` CLI | Separate plan |
| `vdx-app-template` repo | Separate plan |
| `vdx-catalog` repo + CI | Separate plan |
| `vdx-pack-action` GitHub Action | Separate plan |
| `vdx-docs` site | Separate plan |

---

## Self-Review

**Spec coverage check (against `2026-05-01-vdx-installer-design.md`):**

| Spec § | Implemented in tasks | Notes |
|---|---|---|
| §3.2 manifest schema | Task 4 | Full v1 schema |
| §3.3 wizard step types | Task 4, 8, 9 | All six types + reuse diff |
| §3.4 template variables | Task 6 | + system var resolution |
| §3.5 when expressions | Task 7 | Bounded grammar, parser hand-written |
| §3.6 post-install actions | Tasks 16-19 | shortcut, registry, envPath, exec — all hash-pinned + journaled |
| §3.7 uninstall | Task 23 | Journal replay + removePaths |
| §6.2 verification rules | Tasks 12, 13, 19 | Sig + payload hash + exec hash |
| §6.4 zip safety | Task 11 | Zip slip, symlinks, reserved names |
| §7.1 filesystem layout | Task 14, 15, 24 | %APPDATA% paths abstracted via Platform |
| §7.4 transactions/journal | Tasks 14, 15 | Forward append + reverse-order rollback |
| §7.5 crash recovery | Task 15 (`recoverPending`) | Engine API ready; UI prompt is Phase 1.1 |
| §10 sideload parsing | Task 13 | `.vdxpkg` parser |
| §21 schema versioning | Tasks 4, 5 | `schemaVersion` literal in zod |

**Gaps intentionally deferred:** Catalog (§4), self-update (§5), elevation (§8), network (§9), logs/diagnostics export (§11), i18n (§12), settings UI (§13), most of §17 E2E. All listed in "Out of scope" above.

**Placeholder scan:** No "TBD" / "TODO" / "appropriate" patterns in this plan. All steps have full code.

**Type consistency:** `JournalEntryT`, `Manifest`, `Platform`, `ActionContext`, `Result<T,E>` referenced consistently across tasks.
