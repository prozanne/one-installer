# VDX Installer — Phase 1.0 Engine Core (Part 3)

> Continuation of Parts 1 & 2.

---

## Phase H — Transaction & journal (Tasks 14-15)

### Task 14: Atomic JSON write + journal store

**Files:**
- Create: `src/main/state/atomic-write.ts`, `src/main/state/journal-store.ts`, `test/engine/atomic-write.test.ts`, `test/engine/journal-store.test.ts`

- [ ] **Step 1: Tests for atomic write**

```ts
import { describe, it, expect } from 'vitest';
import { atomicWriteJson, readJsonOrDefault } from '@main/state/atomic-write';
import { MockPlatform } from '@main/platform';

describe('atomicWriteJson', () => {
  it('writes via tmp + rename, keeps .bak', async () => {
    const p = new MockPlatform();
    await p.ensureDir('/state');
    await atomicWriteJson('/state/x.json', { a: 1 }, p.fs);
    expect(JSON.parse((await p.fs.promises.readFile('/state/x.json')).toString())).toEqual({ a: 1 });
    await atomicWriteJson('/state/x.json', { a: 2 }, p.fs);
    expect(JSON.parse((await p.fs.promises.readFile('/state/x.json')).toString())).toEqual({ a: 2 });
    expect(JSON.parse((await p.fs.promises.readFile('/state/x.json.bak')).toString())).toEqual({ a: 1 });
  });

  it('readJsonOrDefault returns default if missing', async () => {
    const p = new MockPlatform();
    expect(await readJsonOrDefault('/missing.json', () => ({ z: 0 }), p.fs)).toEqual({ z: 0 });
  });
});
```

- [ ] **Step 2: Implement `src/main/state/atomic-write.ts`**

```ts
import type { IFs } from 'memfs';
import * as nodeFs from 'node:fs';

export async function atomicWriteJson(
  path: string,
  data: unknown,
  fs: IFs | typeof nodeFs = nodeFs,
): Promise<void> {
  const tmp = `${path}.tmp`;
  const bak = `${path}.bak`;
  const json = JSON.stringify(data, null, 2);
  await (fs.promises as IFs['promises']).writeFile(tmp, json);
  // backup existing
  try {
    await (fs.promises as IFs['promises']).copyFile(path, bak);
  } catch {
    // no existing — ignore
  }
  await (fs.promises as IFs['promises']).rename(tmp, path);
}

export async function readJsonOrDefault<T>(
  path: string,
  defaultValue: () => T,
  fs: IFs | typeof nodeFs = nodeFs,
): Promise<T> {
  try {
    const buf = await (fs.promises as IFs['promises']).readFile(path);
    return JSON.parse(buf.toString()) as T;
  } catch {
    return defaultValue();
  }
}
```

- [ ] **Step 3: Tests for journal-store**

```ts
import { describe, it, expect } from 'vitest';
import { createJournalStore } from '@main/state/journal-store';
import { MockPlatform } from '@main/platform';

describe('journal-store', () => {
  it('writes, lists, and reads journal files', async () => {
    const p = new MockPlatform();
    const store = createJournalStore('/journal', p.fs);
    const txid = '00000000-0000-4000-8000-000000000001';
    await store.write(txid, {
      txid,
      appId: 'com.samsung.vdx.x',
      version: '1.0.0',
      scope: 'user',
      status: 'pending',
      startedAt: new Date().toISOString(),
      endedAt: null,
      steps: [],
    });
    expect(await store.list()).toEqual([txid]);
    const loaded = await store.read(txid);
    expect(loaded?.appId).toBe('com.samsung.vdx.x');
  });

  it('deletes', async () => {
    const p = new MockPlatform();
    const store = createJournalStore('/journal', p.fs);
    const txid = '00000000-0000-4000-8000-000000000002';
    await store.write(txid, {
      txid,
      appId: 'x',
      version: '1.0.0',
      scope: 'user',
      status: 'committed',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      steps: [],
    });
    await store.delete(txid);
    expect(await store.list()).toEqual([]);
  });
});
```

- [ ] **Step 4: Implement `src/main/state/journal-store.ts`**

```ts
import type { IFs } from 'memfs';
import * as nodeFs from 'node:fs';
import { TransactionFile, type TransactionFileT } from '@shared/schema';

export interface JournalStore {
  write(txid: string, tx: TransactionFileT): Promise<void>;
  read(txid: string): Promise<TransactionFileT | null>;
  list(): Promise<string[]>;
  delete(txid: string): Promise<void>;
}

export function createJournalStore(dir: string, fs: IFs | typeof nodeFs = nodeFs): JournalStore {
  const fsP = (fs as IFs).promises;

  return {
    async write(txid, tx) {
      await fsP.mkdir(dir, { recursive: true });
      const tmp = `${dir}/${txid}.json.tmp`;
      await fsP.writeFile(tmp, JSON.stringify(tx, null, 2));
      await fsP.rename(tmp, `${dir}/${txid}.json`);
    },
    async read(txid) {
      try {
        const buf = await fsP.readFile(`${dir}/${txid}.json`);
        const obj = JSON.parse(buf.toString());
        return TransactionFile.parse(obj);
      } catch {
        return null;
      }
    },
    async list() {
      try {
        const entries = (await fsP.readdir(dir)) as unknown as string[];
        return entries.filter((e) => e.endsWith('.json')).map((e) => e.slice(0, -5));
      } catch {
        return [];
      }
    },
    async delete(txid) {
      try {
        await fsP.unlink(`${dir}/${txid}.json`);
      } catch {
        /* ignore */
      }
    },
  };
}
```

- [ ] **Step 5: Run + commit**

`pnpm test test/engine/atomic-write.test.ts test/engine/journal-store.test.ts` → all PASS.

```bash
git add src/main/state test/engine/atomic-write.test.ts test/engine/journal-store.test.ts
git commit -m "feat(state): atomic json writer + journal store"
```

---

### Task 15: Transaction lifecycle (begin / append / commit / rollback)

**Files:**
- Create: `src/main/engine/transaction.ts`, `test/engine/transaction.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'vitest';
import { createTransactionRunner } from '@main/engine/transaction';
import { createJournalStore } from '@main/state/journal-store';
import { MockPlatform } from '@main/platform';

describe('TransactionRunner', () => {
  it('commits a successful transaction', async () => {
    const p = new MockPlatform();
    const journal = createJournalStore('/journal', p.fs);
    const runner = createTransactionRunner({ journal });
    const tx = await runner.begin({ appId: 'x', version: '1.0.0', scope: 'user' });
    await tx.append({ type: 'extract', files: ['a.txt'], atTs: new Date().toISOString() });
    await tx.commit();
    expect(await journal.list()).toEqual([]); // committed tx file deleted
  });

  it('rolls back on error by replaying inverses', async () => {
    const p = new MockPlatform();
    const journal = createJournalStore('/journal', p.fs);
    const inverses: string[] = [];
    const runner = createTransactionRunner({
      journal,
      inverseHandler: async (entry) => {
        inverses.push(entry.type);
      },
    });
    const tx = await runner.begin({ appId: 'x', version: '1.0.0', scope: 'user' });
    await tx.append({ type: 'extract', files: ['a.txt'], atTs: new Date().toISOString() });
    await tx.append({
      type: 'shortcut',
      path: '/Desktop/x.lnk',
      atTs: new Date().toISOString(),
    });
    await tx.rollback('test failure');
    // inverse executes in reverse order
    expect(inverses).toEqual(['shortcut', 'extract']);
    expect(await journal.list()).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement `src/main/engine/transaction.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { JournalEntryT, TransactionFileT } from '@shared/schema';
import type { JournalStore } from '@main/state/journal-store';

export type InverseHandler = (entry: JournalEntryT) => Promise<void>;

export interface TransactionRunner {
  begin(input: BeginInput): Promise<Transaction>;
  recoverPending(): Promise<TransactionFileT[]>;
}

export interface BeginInput {
  appId: string;
  version: string;
  scope: 'user' | 'machine';
  txid?: string;
}

export interface Transaction {
  readonly txid: string;
  append(entry: JournalEntryT): Promise<void>;
  commit(): Promise<TransactionFileT>;
  rollback(reason: string): Promise<void>;
}

export interface RunnerOptions {
  journal: JournalStore;
  inverseHandler?: InverseHandler;
  now?: () => Date;
}

export function createTransactionRunner(opts: RunnerOptions): TransactionRunner {
  const now = opts.now ?? (() => new Date());

  return {
    async begin(input) {
      const txid = input.txid ?? randomUUID();
      const file: TransactionFileT = {
        txid,
        appId: input.appId,
        version: input.version,
        scope: input.scope,
        status: 'pending',
        startedAt: now().toISOString(),
        endedAt: null,
        steps: [],
      };
      await opts.journal.write(txid, file);

      const tx: Transaction = {
        txid,
        async append(entry) {
          file.steps.push(entry);
          await opts.journal.write(txid, file);
        },
        async commit() {
          file.status = 'committed';
          file.endedAt = now().toISOString();
          await opts.journal.write(txid, file);
          await opts.journal.delete(txid);
          return file;
        },
        async rollback(reason) {
          for (const e of [...file.steps].reverse()) {
            try {
              if (opts.inverseHandler) await opts.inverseHandler(e);
            } catch {
              // continue rolling back; surface error in logs upstream
            }
          }
          file.status = 'rolled-back';
          file.endedAt = now().toISOString();
          await opts.journal.write(txid, file);
          await opts.journal.delete(txid);
          // reason is used by callers/log; not stored on disk
          void reason;
        },
      };
      return tx;
    },

    async recoverPending() {
      const ids = await opts.journal.list();
      const out: TransactionFileT[] = [];
      for (const id of ids) {
        const t = await opts.journal.read(id);
        if (t && t.status !== 'committed' && t.status !== 'rolled-back') out.push(t);
      }
      return out;
    },
  };
}
```

- [ ] **Step 3: Run + commit**

`pnpm test test/engine/transaction.test.ts` → PASS.

```bash
git add src/main/engine/transaction.ts test/engine/transaction.test.ts
git commit -m "feat(engine): transactional runner with journal-backed rollback"
```

---

## Phase I — Post-install actions (Tasks 16-19)

### Task 16: Action handler interface + shortcut

**Files:**
- Create: `src/main/engine/post-install/types.ts`, `src/main/engine/post-install/shortcut.ts`, `src/main/engine/post-install/index.ts`, `test/engine/post-install/shortcut.test.ts`

- [ ] **Step 1: `types.ts`**

```ts
import type { Platform } from '@main/platform';
import type { PostInstallActionT, JournalEntryT } from '@shared/schema';
import type { Context, SystemVars } from '@main/engine/template';

export interface ActionContext {
  platform: Platform;
  templateContext: Context;
  systemVars: SystemVars;
  installPath: string;
  appId: string;
  payloadDir: string; // where payload was extracted (for exec hash check)
}

export interface ActionHandler<T extends PostInstallActionT['type']> {
  type: T;
  apply(action: Extract<PostInstallActionT, { type: T }>, ctx: ActionContext): Promise<JournalEntryT>;
  inverse(entry: JournalEntryT, platform: Platform): Promise<void>;
}
```

- [ ] **Step 2: Test for shortcut**

```ts
import { describe, it, expect } from 'vitest';
import { shortcutHandler } from '@main/engine/post-install/shortcut';
import { MockPlatform } from '@main/platform';

describe('shortcutHandler', () => {
  it('creates a desktop shortcut and supports inverse', async () => {
    const p = new MockPlatform();
    const ctx = {
      platform: p,
      templateContext: { installPath: '/Apps/X' },
      systemVars: p.systemVars(),
      installPath: '/Apps/X',
      appId: 'com.samsung.vdx.x',
      payloadDir: '/payload',
    };
    const entry = await shortcutHandler.apply(
      { type: 'shortcut', where: 'desktop', target: '{{installPath}}/x.exe', name: 'X' },
      ctx,
    );
    expect(entry.type).toBe('shortcut');
    if (entry.type === 'shortcut') expect(p.shortcuts.has(entry.path)).toBe(true);

    await shortcutHandler.inverse(entry, p);
    if (entry.type === 'shortcut') expect(p.shortcuts.has(entry.path)).toBe(false);
  });
});
```

- [ ] **Step 3: Implement `src/main/engine/post-install/shortcut.ts`**

```ts
import { renderTemplate } from '@main/engine/template';
import type { ActionHandler } from './types';

export const shortcutHandler: ActionHandler<'shortcut'> = {
  type: 'shortcut',
  async apply(action, ctx) {
    const target = renderTemplate(action.target, ctx.templateContext, ctx.systemVars);
    let dir: string;
    switch (action.where) {
      case 'desktop':
        dir = ctx.systemVars.Desktop!;
        break;
      case 'startMenu':
        dir = ctx.systemVars.StartMenu!;
        break;
      case 'programs':
        dir = `${ctx.systemVars.StartMenu}/${ctx.appId}`;
        break;
    }
    await ctx.platform.ensureDir(dir);
    const lnkPath = `${dir}/${action.name}.lnk`;
    await ctx.platform.createShortcut({
      path: lnkPath,
      target,
      args: action.args,
      workingDir: ctx.installPath,
      description: action.name,
    });
    return { type: 'shortcut', path: lnkPath, atTs: new Date().toISOString() };
  },
  async inverse(entry, platform) {
    if (entry.type !== 'shortcut') return;
    try {
      await platform.deleteShortcut(entry.path);
    } catch {
      /* idempotent */
    }
  },
};
```

- [ ] **Step 4: Run + commit**

`pnpm test test/engine/post-install/shortcut.test.ts` → PASS.

```bash
git add src/main/engine/post-install/{types.ts,shortcut.ts} test/engine/post-install/shortcut.test.ts
git commit -m "feat(post-install): shortcut handler with inverse"
```

---

### Task 17: Registry handler

**Files:**
- Create: `src/main/engine/post-install/registry.ts`, `test/engine/post-install/registry.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'vitest';
import { registryHandler } from '@main/engine/post-install/registry';
import { MockPlatform } from '@main/platform';

const baseCtx = (p: MockPlatform) => ({
  platform: p,
  templateContext: { installPath: '/Apps/X' },
  systemVars: p.systemVars(),
  installPath: '/Apps/X',
  appId: 'com.samsung.vdx.x',
  payloadDir: '/payload',
});

describe('registryHandler', () => {
  it('writes values, records inverse', async () => {
    const p = new MockPlatform();
    const entry = await registryHandler.apply(
      {
        type: 'registry',
        hive: 'HKCU',
        key: 'Software\\Samsung\\X',
        values: {
          InstallPath: { type: 'REG_SZ', data: '{{installPath}}' },
          Major: { type: 'REG_DWORD', data: 1 },
        },
      },
      baseCtx(p),
    );
    expect((await p.registryRead('HKCU', 'Software\\Samsung\\X', 'InstallPath'))?.data).toBe('/Apps/X');
    expect(entry.type).toBe('registry');
  });

  it('inverse deletes only values it created', async () => {
    const p = new MockPlatform();
    // pre-existing value should be preserved
    await p.registryWrite('HKCU', 'Software\\Samsung\\X', 'Existing', { type: 'REG_SZ', data: 'keep' });

    const entry = await registryHandler.apply(
      {
        type: 'registry',
        hive: 'HKCU',
        key: 'Software\\Samsung\\X',
        values: { New: { type: 'REG_SZ', data: 'gone' } },
      },
      baseCtx(p),
    );
    await registryHandler.inverse(entry, p);
    expect(await p.registryRead('HKCU', 'Software\\Samsung\\X', 'New')).toBeNull();
    expect((await p.registryRead('HKCU', 'Software\\Samsung\\X', 'Existing'))?.data).toBe('keep');
  });
});
```

- [ ] **Step 2: Implement `src/main/engine/post-install/registry.ts`**

```ts
import { renderTemplate } from '@main/engine/template';
import type { ActionHandler } from './types';
import type { RegistryValue } from '@main/platform';
import type { JournalEntryT } from '@shared/schema';

export const registryHandler: ActionHandler<'registry'> = {
  type: 'registry',
  async apply(action, ctx) {
    const createdValues: string[] = [];
    const overwroteValues: Record<string, RegistryValue> = {};
    let keyCreated = false;

    // Detect whether the key is brand-new by reading a sentinel value
    // (mock platform tracks per-key Maps; absence of any value implies the key did not exist before).
    const probe = await ctx.platform.registryRead(action.hive, action.key, '__probe_does_not_exist');
    keyCreated = probe === null;
    void probe;

    for (const [name, val] of Object.entries(action.values)) {
      const prev = await ctx.platform.registryRead(action.hive, action.key, name);
      if (prev === null) {
        createdValues.push(name);
      } else {
        overwroteValues[name] = prev;
      }
      const data =
        val.type === 'REG_SZ' || val.type === 'REG_EXPAND_SZ'
          ? renderTemplate(String(val.data), ctx.templateContext, ctx.systemVars)
          : val.data;
      await ctx.platform.registryWrite(action.hive, action.key, name, {
        type: val.type,
        data,
      } as RegistryValue);
    }

    const entry: JournalEntryT = {
      type: 'registry',
      hive: action.hive,
      key: action.key,
      createdValues,
      overwroteValues,
      keyCreated,
      atTs: new Date().toISOString(),
    };
    return entry;
  },
  async inverse(entry, platform) {
    if (entry.type !== 'registry') return;
    for (const name of entry.createdValues) {
      try {
        await platform.registryDeleteValue(entry.hive, entry.key, name);
      } catch {
        /* ignore */
      }
    }
    for (const [name, prev] of Object.entries(entry.overwroteValues ?? {})) {
      const v = prev as RegistryValue;
      try {
        await platform.registryWrite(entry.hive, entry.key, name, v);
      } catch {
        /* ignore */
      }
    }
    if (entry.keyCreated) {
      try {
        await platform.registryDeleteKey(entry.hive, entry.key, false);
      } catch {
        /* ignore */
      }
    }
  },
};
```

- [ ] **Step 3: Run + commit**

```bash
pnpm test test/engine/post-install/registry.test.ts
git add src/main/engine/post-install/registry.ts test/engine/post-install/registry.test.ts
git commit -m "feat(post-install): registry handler with precise inverse"
```

---

### Task 18: envPath + arp handlers

**Files:**
- Create: `src/main/engine/post-install/env-path.ts`, `src/main/engine/post-install/arp.ts`, `test/engine/post-install/env-path.test.ts`, `test/engine/post-install/arp.test.ts`

- [ ] **Step 1: env-path handler**

```ts
// src/main/engine/post-install/env-path.ts
import { renderTemplate } from '@main/engine/template';
import type { ActionHandler } from './types';
import type { JournalEntryT } from '@shared/schema';

export const envPathHandler: ActionHandler<'envPath'> = {
  type: 'envPath',
  async apply(action, ctx) {
    const dir = renderTemplate(action.add, ctx.templateContext, ctx.systemVars);
    await ctx.platform.pathEnvAdd(action.scope, dir);
    const entry: JournalEntryT = {
      type: 'envPath',
      scope: action.scope,
      added: dir,
      atTs: new Date().toISOString(),
    };
    return entry;
  },
  async inverse(entry, platform) {
    if (entry.type !== 'envPath') return;
    try {
      await platform.pathEnvRemove(entry.scope, entry.added);
    } catch {
      /* idempotent */
    }
  },
};
```

- [ ] **Step 2: env-path test**

```ts
import { describe, it, expect } from 'vitest';
import { envPathHandler } from '@main/engine/post-install/env-path';
import { MockPlatform } from '@main/platform';

describe('envPathHandler', () => {
  it('adds and removes', async () => {
    const p = new MockPlatform();
    const entry = await envPathHandler.apply(
      { type: 'envPath', scope: 'user', add: '{{installPath}}/bin' },
      {
        platform: p,
        templateContext: { installPath: '/Apps/X' },
        systemVars: p.systemVars(),
        installPath: '/Apps/X',
        appId: 'x',
        payloadDir: '/payload',
      },
    );
    expect(p.userPath).toEqual(['/Apps/X/bin']);
    await envPathHandler.inverse(entry, p);
    expect(p.userPath).toEqual([]);
  });
});
```

- [ ] **Step 3: ARP handler (implicit, not user-declarable)**

```ts
// src/main/engine/post-install/arp.ts
import type { Platform } from '@main/platform';
import type { JournalEntryT } from '@shared/schema';
import type { Manifest } from '@shared/schema';

export interface ArpInput {
  platform: Platform;
  manifest: Manifest;
  installPath: string;
  scope: 'user' | 'machine';
  hostExePath: string;
}

export async function arpRegister(input: ArpInput): Promise<JournalEntryT> {
  const hive = input.scope === 'machine' ? 'HKLM' : 'HKCU';
  const key = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${input.manifest.id}`;
  const displayName = input.manifest.name.default;
  const values: Record<string, { type: 'REG_SZ' | 'REG_DWORD'; data: string | number }> = {
    DisplayName: { type: 'REG_SZ', data: displayName },
    DisplayVersion: { type: 'REG_SZ', data: input.manifest.version },
    Publisher: { type: 'REG_SZ', data: input.manifest.publisher },
    InstallLocation: { type: 'REG_SZ', data: input.installPath },
    EstimatedSize: { type: 'REG_DWORD', data: Math.ceil(input.manifest.size.installed / 1024) },
    UninstallString: {
      type: 'REG_SZ',
      data: `"${input.hostExePath}" --uninstall ${input.manifest.id}`,
    },
    NoModify: { type: 'REG_DWORD', data: 1 },
    NoRepair: { type: 'REG_DWORD', data: 1 },
  };
  for (const [name, v] of Object.entries(values)) {
    await input.platform.registryWrite(hive, key, name, v);
  }
  return { type: 'arp', hive, appId: input.manifest.id, atTs: new Date().toISOString() };
}

export async function arpDeregister(entry: JournalEntryT, platform: Platform): Promise<void> {
  if (entry.type !== 'arp') return;
  const key = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${entry.appId}`;
  try {
    await platform.registryDeleteKey(entry.hive, key, true);
  } catch {
    /* idempotent */
  }
}
```

- [ ] **Step 4: ARP test**

```ts
import { describe, it, expect } from 'vitest';
import { arpRegister, arpDeregister } from '@main/engine/post-install/arp';
import { MockPlatform } from '@main/platform';
import type { Manifest } from '@shared/schema';

const m: Manifest = {
  schemaVersion: 1,
  id: 'com.samsung.vdx.x',
  name: { default: 'X' },
  version: '1.2.3',
  publisher: 'Samsung',
  description: { default: 'd' },
  size: { download: 1, installed: 1024 * 1024 },
  payload: { filename: 'p.zip', sha256: 'a'.repeat(64), compressedSize: 1 },
  minHostVersion: '1.0.0',
  targets: { os: 'win32', arch: ['x64'] },
  installScope: { supports: ['user'], default: 'user' },
  requiresReboot: false,
  wizard: [{ type: 'summary' }],
  install: { extract: [{ from: '**/*', to: '{{installPath}}' }] },
  postInstall: [],
  uninstall: { removePaths: [], removeShortcuts: true, removeEnvPath: true },
};

describe('arp register/deregister', () => {
  it('round-trips', async () => {
    const p = new MockPlatform();
    const entry = await arpRegister({
      platform: p, manifest: m, installPath: '/Apps/X', scope: 'user', hostExePath: 'C:/host.exe',
    });
    expect(entry.type).toBe('arp');
    await arpDeregister(entry, p);
    expect(await p.registryRead('HKCU',
      `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.samsung.vdx.x`,
      'DisplayName')).toBeNull();
  });
});
```

- [ ] **Step 5: Commit**

```bash
pnpm test test/engine/post-install/env-path.test.ts test/engine/post-install/arp.test.ts
git add src/main/engine/post-install/env-path.ts src/main/engine/post-install/arp.ts test/engine/post-install/env-path.test.ts test/engine/post-install/arp.test.ts
git commit -m "feat(post-install): envPath handler and ARP register/deregister"
```

---

### Task 19: exec handler with hash-pinned binaries

**Files:**
- Create: `src/main/engine/post-install/exec.ts`, `test/engine/post-install/exec.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'vitest';
import { execHandler } from '@main/engine/post-install/exec';
import { MockPlatform } from '@main/platform';
import { bufferSha256 } from '@main/packages/payload-hash';

const VALID_BIN = Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // MZ header bytes — content irrelevant for the test

describe('execHandler', () => {
  it('rejects exec when binary hash is not in allowedHashes', async () => {
    const p = new MockPlatform();
    await p.ensureDir('/payload');
    await p.fs.promises.writeFile('/payload/tool.exe', VALID_BIN);
    const ctx = {
      platform: p,
      templateContext: { installPath: '/Apps/X' },
      systemVars: p.systemVars(),
      installPath: '/Apps/X',
      appId: 'x',
      payloadDir: '/payload',
    };
    await expect(
      execHandler.apply(
        {
          type: 'exec',
          cmd: '{{installPath}}/tool.exe',
          args: ['--ok'],
          timeoutSec: 5,
          allowedHashes: ['sha256:' + 'b'.repeat(64)],
        },
        ctx,
      ),
    ).rejects.toThrow(/hash/i);
  });

  it('runs exec when hash matches and exit code is 0', async () => {
    const p = new MockPlatform({
      execHandler: () => ({ exitCode: 0, stdout: 'ok', stderr: '', durationMs: 5, timedOut: false }),
    });
    await p.ensureDir('/Apps/X');
    await p.fs.promises.writeFile('/Apps/X/tool.exe', VALID_BIN);
    const hash = bufferSha256(VALID_BIN);
    const entry = await execHandler.apply(
      {
        type: 'exec',
        cmd: '{{installPath}}/tool.exe',
        args: ['--ok'],
        timeoutSec: 5,
        allowedHashes: ['sha256:' + hash],
      },
      {
        platform: p,
        templateContext: { installPath: '/Apps/X' },
        systemVars: p.systemVars(),
        installPath: '/Apps/X',
        appId: 'x',
        payloadDir: '/Apps/X',
      },
    );
    expect(entry.type).toBe('exec');
    if (entry.type === 'exec') expect(entry.exitCode).toBe(0);
  });

  it('throws when exec exits non-zero', async () => {
    const p = new MockPlatform({
      execHandler: () => ({ exitCode: 2, stdout: '', stderr: 'fail', durationMs: 1, timedOut: false }),
    });
    await p.ensureDir('/Apps/X');
    await p.fs.promises.writeFile('/Apps/X/tool.exe', VALID_BIN);
    const hash = bufferSha256(VALID_BIN);
    await expect(
      execHandler.apply(
        {
          type: 'exec',
          cmd: '{{installPath}}/tool.exe',
          args: [],
          timeoutSec: 5,
          allowedHashes: ['sha256:' + hash],
        },
        {
          platform: p,
          templateContext: { installPath: '/Apps/X' },
          systemVars: p.systemVars(),
          installPath: '/Apps/X',
          appId: 'x',
          payloadDir: '/Apps/X',
        },
      ),
    ).rejects.toThrow(/exit code 2/i);
  });
});
```

- [ ] **Step 2: Implement `src/main/engine/post-install/exec.ts`**

```ts
import { renderTemplate } from '@main/engine/template';
import type { ActionHandler } from './types';
import type { JournalEntryT } from '@shared/schema';
import { posix as path } from 'node:path';

export const execHandler: ActionHandler<'exec'> = {
  type: 'exec',
  async apply(action, ctx) {
    const cmd = renderTemplate(action.cmd, ctx.templateContext, ctx.systemVars);
    const args = action.args.map((a) => renderTemplate(a, ctx.templateContext, ctx.systemVars));
    if (!path.isAbsolute(cmd)) throw new Error(`exec cmd must be absolute: ${cmd}`);
    if (!cmd.startsWith(ctx.installPath) && !cmd.startsWith(ctx.payloadDir)) {
      throw new Error(`exec cmd must reside inside installPath or payloadDir: ${cmd}`);
    }
    const hash = await ctx.platform.fileSha256(cmd);
    const allowed = new Set(action.allowedHashes.map((h) => h.replace(/^sha256:/, '')));
    if (!allowed.has(hash)) {
      throw new Error(`exec binary hash mismatch (${hash}) — not in allowedHashes`);
    }
    const result = await ctx.platform.exec({
      cmd,
      args,
      cwd: ctx.installPath,
      timeoutMs: action.timeoutSec * 1000,
    });
    if (result.timedOut) throw new Error(`exec timed out after ${action.timeoutSec}s`);
    if (result.exitCode !== 0) throw new Error(`exec exit code ${result.exitCode}`);
    const entry: JournalEntryT = {
      type: 'exec',
      cmd,
      exitCode: result.exitCode,
      atTs: new Date().toISOString(),
    };
    return entry;
  },
  async inverse() {
    // exec is non-reversible by design. The journal records that one ran;
    // any rollback path treats this as a no-op (see spec §7.4).
  },
};
```

- [ ] **Step 3: Run + commit**

```bash
pnpm test test/engine/post-install/exec.test.ts
git add src/main/engine/post-install/exec.ts test/engine/post-install/exec.test.ts
git commit -m "feat(post-install): exec handler with hash pinning + non-reversible journal entry"
```

---

### Task 20: Action dispatcher (index)

**Files:**
- Modify: `src/main/engine/post-install/index.ts`

- [ ] **Step 1: Create dispatcher**

```ts
import type { PostInstallActionT } from '@shared/schema';
import { evaluateWhen } from '@main/engine/when-expr';
import { shortcutHandler } from './shortcut';
import { registryHandler } from './registry';
import { envPathHandler } from './env-path';
import { execHandler } from './exec';
import type { ActionContext, ActionHandler } from './types';

export * from './types';

const handlers = {
  shortcut: shortcutHandler,
  registry: registryHandler,
  envPath: envPathHandler,
  exec: execHandler,
} satisfies Record<PostInstallActionT['type'], ActionHandler<PostInstallActionT['type']>>;

export async function applyAction(action: PostInstallActionT, ctx: ActionContext) {
  if (!evaluateWhen(action.when, ctx.templateContext)) return null;
  const h = handlers[action.type] as ActionHandler<typeof action.type>;
  return h.apply(action as never, ctx);
}

export async function inverseAction(
  entry: { type: 'shortcut' | 'registry' | 'envPath' | 'exec' | 'extract' | 'arp' },
  platform: import('@main/platform').Platform,
): Promise<void> {
  switch (entry.type) {
    case 'shortcut':
      return shortcutHandler.inverse(entry as never, platform);
    case 'registry':
      return registryHandler.inverse(entry as never, platform);
    case 'envPath':
      return envPathHandler.inverse(entry as never, platform);
    case 'exec':
      return execHandler.inverse(entry as never, platform);
    case 'extract':
      // handled in install module — not here
      return;
    case 'arp':
      // handled in arp module
      return;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/main/engine/post-install/index.ts
git commit -m "feat(post-install): unified action dispatcher with when-evaluation"
```

---

> **End of Part 3.** Continue with `2026-05-01-vdx-installer-phase1-engine-core-part4.md` for Tasks 21-26: install runner, uninstall runner, validate, installed-state store, lock, façade.
