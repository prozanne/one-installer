# VDX Installer — Phase 1.0 Engine Core (Part 2)

> Continuation of `2026-05-01-vdx-installer-phase1-engine-core.md`. Same goal/architecture/tech stack — see Part 1.

---

## Phase D — Wizard logic (Tasks 8-9)

### Task 8: Wizard validation + step-by-step iteration

**Files:**
- Create: `src/main/engine/wizard.ts`, `test/engine/wizard.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'vitest';
import { validateAnswer, computeWizardOrder } from '@main/engine/wizard';
import type { WizardStepT } from '@shared/schema';

describe('validateAnswer', () => {
  it('accepts valid checkbox group with required item set', () => {
    const step: WizardStepT = {
      type: 'checkboxGroup',
      id: 'comp',
      label: { default: 'C' },
      items: [
        { id: 'core', label: { default: 'Core' }, default: true, required: true },
        { id: 'samples', label: { default: 'S' }, default: false, required: false },
      ],
    };
    expect(validateAnswer(step, { core: true, samples: false }).ok).toBe(true);
  });

  it('rejects checkbox group missing required item', () => {
    const step: WizardStepT = {
      type: 'checkboxGroup',
      id: 'comp',
      label: { default: 'C' },
      items: [{ id: 'core', label: { default: 'Core' }, default: true, required: true }],
    };
    const r = validateAnswer(step, { core: false });
    expect(r.ok).toBe(false);
  });

  it('rejects text not matching regex', () => {
    const step: WizardStepT = {
      type: 'text',
      id: 'name',
      label: { default: 'N' },
      default: '',
      regex: '^[a-z]{1,4}$',
      optional: false,
    };
    expect(validateAnswer(step, 'TOOLONG').ok).toBe(false);
    expect(validateAnswer(step, 'abc').ok).toBe(true);
  });

  it('rejects path that is empty when not optional', () => {
    const step: WizardStepT = { type: 'path', id: 'p', label: { default: 'P' }, default: '' };
    expect(validateAnswer(step, '').ok).toBe(false);
    expect(validateAnswer(step, 'C:/X').ok).toBe(true);
  });
});

describe('computeWizardOrder', () => {
  it('returns steps in declaration order, summary last', () => {
    const steps: WizardStepT[] = [
      { type: 'path', id: 'p', label: { default: 'P' }, default: '' },
      { type: 'summary' },
    ];
    expect(computeWizardOrder(steps).map((s) => s.type)).toEqual(['path', 'summary']);
  });
});
```

- [ ] **Step 2: Implement `src/main/engine/wizard.ts`**

```ts
import type { WizardStepT } from '@shared/schema';
import type { AnswerValue } from '@shared/types';
import { ok, err, type Result } from '@shared/types';

export function computeWizardOrder(steps: WizardStepT[]): WizardStepT[] {
  return [...steps];
}

export function validateAnswer(step: WizardStepT, answer: unknown): Result<AnswerValue, string> {
  switch (step.type) {
    case 'license':
      return answer === true ? ok(true) : err('License must be accepted');
    case 'path': {
      if (typeof answer !== 'string') return err('Path must be a string');
      if (answer.trim() === '') return err('Path cannot be empty');
      return ok(answer);
    }
    case 'text': {
      if (typeof answer !== 'string') return err('Text must be a string');
      if (!step.optional && answer.trim() === '') return err('Field is required');
      if (step.regex) {
        const re = new RegExp(step.regex);
        if (!re.test(answer)) return err(`Does not match pattern: ${step.regex}`);
      }
      return ok(answer);
    }
    case 'select': {
      if (typeof answer !== 'string') return err('Select value must be a string');
      const valid = step.options.some((o) => o.value === answer);
      return valid ? ok(answer) : err(`Value '${answer}' not in options`);
    }
    case 'checkboxGroup': {
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
        return err('Checkbox group answer must be an object');
      }
      const obj = answer as Record<string, unknown>;
      for (const item of step.items) {
        const v = obj[item.id];
        if (typeof v !== 'boolean') return err(`Missing or non-boolean for '${item.id}'`);
        if (item.required && v === false) return err(`'${item.id}' is required`);
      }
      const out: Record<string, boolean> = {};
      for (const item of step.items) out[item.id] = obj[item.id] as boolean;
      return ok(out);
    }
    case 'summary':
      return ok(true);
  }
}
```

- [ ] **Step 3: Run** — `pnpm test test/engine/wizard.test.ts` → PASS.

- [ ] **Step 4: Commit** — `feat(engine): wizard answer validation`

---

### Task 9: Wizard answer reuse diff (for updates)

**Files:**
- Modify: `src/main/engine/wizard.ts`
- Create: `test/engine/wizard-reuse.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'vitest';
import { diffWizardForReuse } from '@main/engine/wizard';
import type { WizardStepT } from '@shared/schema';

describe('diffWizardForReuse', () => {
  const oldSteps: WizardStepT[] = [
    { type: 'path', id: 'installPath', label: { default: 'P' }, default: '' },
    { type: 'select', id: 'shortcut', label: { default: 'S' }, options: [
      { value: 'menu', label: { default: 'M' }, default: true },
    ] },
    { type: 'summary' },
  ];

  const savedAnswers = { installPath: 'C:/X', shortcut: 'menu' };

  it('reuses everything when wizard unchanged', () => {
    const diff = diffWizardForReuse(oldSteps, oldSteps, savedAnswers);
    expect(diff.mustAsk).toEqual([]);
    expect(diff.reused).toEqual({ installPath: 'C:/X', shortcut: 'menu' });
  });

  it('asks only the new step when one is added', () => {
    const newSteps: WizardStepT[] = [
      ...oldSteps.slice(0, 2),
      { type: 'text', id: 'deviceName', label: { default: 'D' }, default: '', optional: true },
      { type: 'summary' },
    ];
    const diff = diffWizardForReuse(newSteps, oldSteps, savedAnswers);
    expect(diff.mustAsk.map((s) => s.id ?? s.type)).toEqual(['deviceName']);
    expect(diff.reused).toEqual({ installPath: 'C:/X', shortcut: 'menu' });
  });

  it('asks the changed step when type differs', () => {
    const newSteps: WizardStepT[] = [
      { type: 'text', id: 'installPath', label: { default: 'P' }, default: '', optional: false },
      ...oldSteps.slice(1),
    ];
    const diff = diffWizardForReuse(newSteps, oldSteps, savedAnswers);
    expect(diff.mustAsk.map((s) => s.id ?? s.type)).toEqual(['installPath']);
    expect(diff.reused.installPath).toBeUndefined();
  });

  it('canSkipWizard true if no must-ask and only summary remains', () => {
    const diff = diffWizardForReuse(oldSteps, oldSteps, savedAnswers);
    expect(diff.canSkipWizard).toBe(true);
  });
});
```

- [ ] **Step 2: Append to `src/main/engine/wizard.ts`**

```ts
export interface WizardDiff {
  mustAsk: WizardStepT[];
  reused: Record<string, unknown>;
  canSkipWizard: boolean;
}

const stepKey = (s: WizardStepT): string => ('id' in s ? s.id : s.type);

export function diffWizardForReuse(
  newSteps: WizardStepT[],
  oldSteps: WizardStepT[],
  savedAnswers: Record<string, unknown>,
): WizardDiff {
  const oldByKey = new Map(oldSteps.map((s) => [stepKey(s), s]));
  const mustAsk: WizardStepT[] = [];
  const reused: Record<string, unknown> = {};
  for (const ns of newSteps) {
    if (ns.type === 'summary') continue;
    const key = stepKey(ns);
    const os = oldByKey.get(key);
    if (os && os.type === ns.type && key in savedAnswers) {
      reused[key] = savedAnswers[key];
    } else {
      mustAsk.push(ns);
    }
  }
  return { mustAsk, reused, canSkipWizard: mustAsk.length === 0 };
}
```

- [ ] **Step 3: Run** — `pnpm test test/engine/` → all green.

- [ ] **Step 4: Commit** — `feat(engine): wizard answer reuse diff`

---

## Phase E — Platform abstraction (Tasks 10-12)

### Task 10: Platform interface + mock impl

**Files:**
- Create: `src/main/platform/types.ts`, `src/main/platform/mock.ts`, `src/main/platform/system-paths.ts`, `src/main/platform/index.ts`, `test/engine/platform-mock.test.ts`

- [ ] **Step 1: Define `src/main/platform/types.ts`**

```ts
import type { SystemVars } from '@main/engine/template';

export type RegHive = 'HKCU' | 'HKLM';

export interface RegistryValue {
  type: 'REG_SZ' | 'REG_DWORD' | 'REG_QWORD' | 'REG_EXPAND_SZ' | 'REG_MULTI_SZ' | 'REG_BINARY';
  data: string | number | string[];
}

export interface ShortcutInput {
  path: string;          // .lnk path
  target: string;        // target exe
  args?: string;
  workingDir?: string;
  iconPath?: string;
  description?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ExecInput {
  cmd: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
  env?: Record<string, string>;
}

export interface Platform {
  systemVars(): SystemVars;
  pathExists(p: string): Promise<boolean>;
  ensureDir(p: string): Promise<void>;
  rmDir(p: string, opts?: { recursive: boolean }): Promise<void>;
  rmFile(p: string): Promise<void>;
  moveFile(from: string, to: string, opts?: { overwrite?: boolean }): Promise<void>;
  diskFreeBytes(driveLetter: string): Promise<bigint>;
  createShortcut(input: ShortcutInput): Promise<void>;
  deleteShortcut(path: string): Promise<void>;
  registryRead(hive: RegHive, key: string, valueName: string): Promise<RegistryValue | null>;
  registryWrite(hive: RegHive, key: string, valueName: string, value: RegistryValue): Promise<void>;
  registryDeleteValue(hive: RegHive, key: string, valueName: string): Promise<void>;
  registryDeleteKey(hive: RegHive, key: string, recursive: boolean): Promise<void>;
  pathEnvAdd(scope: 'user' | 'machine', dir: string): Promise<void>;
  pathEnvRemove(scope: 'user' | 'machine', dir: string): Promise<void>;
  exec(input: ExecInput): Promise<ExecResult>;
  fileSha256(path: string): Promise<string>;
  isProcessRunning(exePath: string): Promise<{ running: boolean; pid?: number }>;
}
```

- [ ] **Step 2: `src/main/platform/system-paths.ts`**

```ts
import type { SystemVars } from '@main/engine/template';

export interface SystemPathsInput {
  programFiles: string;
  programFilesX86: string;
  localAppData: string;
  desktop: string;
  startMenu: string;
  temp: string;
  installerVersion: string;
  appId: string;
  appVersion: string;
}

export function buildSystemVars(input: SystemPathsInput): SystemVars {
  return {
    ProgramFiles: input.programFiles,
    ProgramFilesX86: input.programFilesX86,
    LocalAppData: input.localAppData,
    Desktop: input.desktop,
    StartMenu: input.startMenu,
    Temp: input.temp,
    InstallerVersion: input.installerVersion,
    AppId: input.appId,
    AppVersion: input.appVersion,
  };
}
```

- [ ] **Step 3: `src/main/platform/mock.ts`**

In-memory mock backed by Map structures and memfs for files. Used by all engine tests.

```ts
import { Volume, createFsFromVolume, type IFs } from 'memfs';
import { createHash } from 'node:crypto';
import { buildSystemVars } from './system-paths';
import type { ExecInput, ExecResult, Platform, RegHive, RegistryValue, ShortcutInput } from './types';

export interface MockPlatformOptions {
  programFiles?: string;
  localAppData?: string;
  installerVersion?: string;
  diskFreeBytes?: bigint;
  execHandler?: (input: ExecInput) => ExecResult | Promise<ExecResult>;
}

export class MockPlatform implements Platform {
  readonly fs: IFs;
  readonly registry = new Map<string, Map<string, RegistryValue>>();
  readonly shortcuts = new Map<string, ShortcutInput>();
  readonly userPath: string[] = [];
  readonly machinePath: string[] = [];
  readonly execLog: ExecInput[] = [];
  private readonly _diskFreeBytes: bigint;
  private readonly _execHandler: NonNullable<MockPlatformOptions['execHandler']>;
  readonly opts: Required<Pick<MockPlatformOptions, 'programFiles' | 'localAppData' | 'installerVersion'>>;

  constructor(opts: MockPlatformOptions = {}) {
    this.fs = createFsFromVolume(new Volume());
    this._diskFreeBytes = opts.diskFreeBytes ?? 100n * 1024n * 1024n * 1024n;
    this._execHandler =
      opts.execHandler ??
      (() => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false }));
    this.opts = {
      programFiles: opts.programFiles ?? 'C:/Program Files',
      localAppData: opts.localAppData ?? 'C:/Users/u/AppData/Local',
      installerVersion: opts.installerVersion ?? '0.1.0-dev',
    };
  }

  systemVars() {
    return buildSystemVars({
      programFiles: this.opts.programFiles,
      programFilesX86: 'C:/Program Files (x86)',
      localAppData: this.opts.localAppData,
      desktop: `${this.opts.localAppData}/../Desktop`,
      startMenu: `${this.opts.localAppData}/../AppData/Roaming/Microsoft/Windows/Start Menu/Programs`,
      temp: 'C:/Windows/Temp',
      installerVersion: this.opts.installerVersion,
      appId: '',
      appVersion: '',
    });
  }

  async pathExists(p: string): Promise<boolean> {
    try {
      await this.fs.promises.stat(p);
      return true;
    } catch {
      return false;
    }
  }

  async ensureDir(p: string): Promise<void> {
    await this.fs.promises.mkdir(p, { recursive: true });
  }

  async rmDir(p: string, opts?: { recursive: boolean }): Promise<void> {
    await this.fs.promises.rm(p, { recursive: opts?.recursive ?? false, force: true });
  }

  async rmFile(p: string): Promise<void> {
    await this.fs.promises.unlink(p);
  }

  async moveFile(from: string, to: string, opts?: { overwrite?: boolean }): Promise<void> {
    if (!(opts?.overwrite ?? false) && (await this.pathExists(to))) {
      throw new Error(`Destination exists: ${to}`);
    }
    const data = await this.fs.promises.readFile(from);
    await this.fs.promises.mkdir(this.dirname(to), { recursive: true });
    await this.fs.promises.writeFile(to, data);
    await this.fs.promises.unlink(from);
  }

  async diskFreeBytes(): Promise<bigint> {
    return this._diskFreeBytes;
  }

  async createShortcut(input: ShortcutInput): Promise<void> {
    if (this.shortcuts.has(input.path)) throw new Error(`Shortcut exists: ${input.path}`);
    this.shortcuts.set(input.path, input);
  }

  async deleteShortcut(path: string): Promise<void> {
    if (!this.shortcuts.delete(path)) throw new Error(`Shortcut not found: ${path}`);
  }

  private regKey(hive: RegHive, key: string): string {
    return `${hive}::${key.replace(/\\/g, '\\').toLowerCase()}`;
  }

  async registryRead(hive: RegHive, key: string, valueName: string): Promise<RegistryValue | null> {
    return this.registry.get(this.regKey(hive, key))?.get(valueName) ?? null;
  }

  async registryWrite(hive: RegHive, key: string, valueName: string, value: RegistryValue): Promise<void> {
    const k = this.regKey(hive, key);
    let m = this.registry.get(k);
    if (!m) {
      m = new Map();
      this.registry.set(k, m);
    }
    m.set(valueName, value);
  }

  async registryDeleteValue(hive: RegHive, key: string, valueName: string): Promise<void> {
    this.registry.get(this.regKey(hive, key))?.delete(valueName);
  }

  async registryDeleteKey(hive: RegHive, key: string, recursive: boolean): Promise<void> {
    const prefix = this.regKey(hive, key);
    if (recursive) {
      for (const k of [...this.registry.keys()]) {
        if (k === prefix || k.startsWith(prefix + '\\')) this.registry.delete(k);
      }
    } else {
      this.registry.delete(prefix);
    }
  }

  async pathEnvAdd(scope: 'user' | 'machine', dir: string): Promise<void> {
    const list = scope === 'user' ? this.userPath : this.machinePath;
    if (!list.includes(dir)) list.push(dir);
  }

  async pathEnvRemove(scope: 'user' | 'machine', dir: string): Promise<void> {
    const list = scope === 'user' ? this.userPath : this.machinePath;
    const i = list.indexOf(dir);
    if (i >= 0) list.splice(i, 1);
  }

  async exec(input: ExecInput): Promise<ExecResult> {
    this.execLog.push(input);
    return this._execHandler(input);
  }

  async fileSha256(p: string): Promise<string> {
    const buf = await this.fs.promises.readFile(p);
    return createHash('sha256').update(buf).digest('hex');
  }

  async isProcessRunning(): Promise<{ running: boolean; pid?: number }> {
    return { running: false };
  }

  private dirname(p: string): string {
    return p.replace(/\/[^/]*$/, '');
  }
}
```

- [ ] **Step 4: `src/main/platform/index.ts`**

```ts
export * from './types';
export * from './mock';
export * from './system-paths';
```

- [ ] **Step 5: Quick smoke test `test/engine/platform-mock.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { MockPlatform } from '@main/platform';

describe('MockPlatform', () => {
  it('writes and reads files', async () => {
    const p = new MockPlatform();
    await p.ensureDir('/tmp');
    await p.fs.promises.writeFile('/tmp/x.txt', 'hi');
    expect(await p.pathExists('/tmp/x.txt')).toBe(true);
  });

  it('hashes files', async () => {
    const p = new MockPlatform();
    await p.ensureDir('/tmp');
    await p.fs.promises.writeFile('/tmp/x.txt', 'abc');
    expect(await p.fileSha256('/tmp/x.txt')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('writes registry values', async () => {
    const p = new MockPlatform();
    await p.registryWrite('HKCU', 'Software\\X', 'V', { type: 'REG_SZ', data: 'hello' });
    expect(await p.registryRead('HKCU', 'Software\\X', 'V')).toEqual({ type: 'REG_SZ', data: 'hello' });
  });
});
```

- [ ] **Step 6: Run + Commit**

`pnpm test test/engine/platform-mock.test.ts` → PASS.

```bash
git add src/main/platform test/engine/platform-mock.test.ts
git commit -m "feat(platform): platform interface + memfs-backed mock impl"
```

---

## Phase F — Zip safety + payload hashing (Tasks 11-12)

### Task 11: Safe zip extractor

**Files:**
- Create: `src/main/packages/zip-safe.ts`, `test/engine/zip-safe.test.ts`
- Create test helpers: `test/helpers/make-zip.ts`

- [ ] **Step 1: `test/helpers/make-zip.ts`** — produce a Buffer with given file map (uses yazl)

```ts
import yazl from 'yazl';

export function makeZip(files: Record<string, string | Buffer>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, content] of Object.entries(files)) {
      const buf = typeof content === 'string' ? Buffer.from(content) : content;
      zip.addBuffer(buf, name);
    }
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c) => chunks.push(c as Buffer));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
}
```

- [ ] **Step 2: Test**

```ts
import { describe, it, expect } from 'vitest';
import { extractZipSafe, listZipEntries } from '@main/packages/zip-safe';
import { makeZip } from '../helpers/make-zip';
import { MockPlatform } from '@main/platform';

describe('extractZipSafe', () => {
  it('extracts plain files', async () => {
    const buf = await makeZip({ 'a.txt': 'hello', 'sub/b.txt': 'world' });
    const p = new MockPlatform();
    await p.ensureDir('/out');
    const result = await extractZipSafe({ zipBytes: buf, destDir: '/out', fs: p.fs });
    expect(result.files.sort()).toEqual(['a.txt', 'sub/b.txt']);
    expect((await p.fs.promises.readFile('/out/a.txt', 'utf-8')).toString()).toBe('hello');
    expect((await p.fs.promises.readFile('/out/sub/b.txt', 'utf-8')).toString()).toBe('world');
  });

  it('rejects zip slip (../)', async () => {
    const buf = await makeZip({ '../escape.txt': 'bad' });
    const p = new MockPlatform();
    await p.ensureDir('/out');
    await expect(extractZipSafe({ zipBytes: buf, destDir: '/out', fs: p.fs })).rejects.toThrow(/zip slip/i);
  });

  it('rejects absolute path entry', async () => {
    const buf = await makeZip({ '/abs/x.txt': 'bad' });
    const p = new MockPlatform();
    await p.ensureDir('/out');
    await expect(extractZipSafe({ zipBytes: buf, destDir: '/out', fs: p.fs })).rejects.toThrow(/absolute/i);
  });

  it('rejects reserved windows name', async () => {
    const buf = await makeZip({ 'CON.txt': 'bad' });
    const p = new MockPlatform();
    await p.ensureDir('/out');
    await expect(extractZipSafe({ zipBytes: buf, destDir: '/out', fs: p.fs })).rejects.toThrow(/reserved/i);
  });

  it('listZipEntries returns names without extracting', async () => {
    const buf = await makeZip({ 'a.txt': 'x', 'b.txt': 'y' });
    expect((await listZipEntries(buf)).sort()).toEqual(['a.txt', 'b.txt']);
  });
});
```

- [ ] **Step 3: Implement `src/main/packages/zip-safe.ts`**

```ts
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { posix as path } from 'node:path';
import type { IFs } from 'memfs';
import * as nodeFs from 'node:fs';

const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

export interface ExtractInput {
  zipBytes: Buffer;
  destDir: string;
  fs?: IFs | typeof nodeFs;
}

export interface ExtractResult {
  files: string[];
  totalBytes: number;
}

function checkEntryName(name: string): void {
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new Error(`Refusing entry with absolute path: ${name}`);
  }
  const norm = path.normalize(name);
  if (norm.startsWith('..') || norm.includes('/../') || norm === '..') {
    throw new Error(`Refusing entry due to zip slip: ${name}`);
  }
  for (const part of norm.split('/')) {
    const base = part.split('.')[0]?.toUpperCase();
    if (base && RESERVED.has(base)) throw new Error(`Refusing reserved Windows name: ${name}`);
    if (/[\s.]$/.test(part)) throw new Error(`Refusing trailing space/dot in name: ${name}`);
  }
}

function openZip(buf: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('open zip failed'));
      resolve(zip);
    });
  });
}

export async function listZipEntries(buf: Buffer): Promise<string[]> {
  const zip = await openZip(buf);
  const out: string[] = [];
  return new Promise((resolve, reject) => {
    zip.on('entry', (e: Entry) => {
      out.push(e.fileName);
      zip.readEntry();
    });
    zip.on('end', () => resolve(out));
    zip.on('error', reject);
    zip.readEntry();
  });
}

export async function extractZipSafe(input: ExtractInput): Promise<ExtractResult> {
  const fs = (input.fs ?? nodeFs) as IFs;
  const zip = await openZip(input.zipBytes);
  const out: string[] = [];
  let totalBytes = 0;

  await new Promise<void>((resolve, reject) => {
    zip.on('entry', (e: Entry) => {
      try {
        // External attributes: detect symlinks (POSIX file type 0xA000)
        const externalAttr = (e.externalFileAttributes ?? 0) >>> 16;
        const fileType = externalAttr & 0xf000;
        if (fileType === 0xa000) {
          throw new Error(`Refusing symlink entry: ${e.fileName}`);
        }
        if (/\/$/.test(e.fileName)) {
          // directory
          fs.promises
            .mkdir(path.join(input.destDir, e.fileName), { recursive: true })
            .then(() => zip.readEntry())
            .catch(reject);
          return;
        }
        checkEntryName(e.fileName);
        const dest = path.join(input.destDir, e.fileName);
        zip.openReadStream(e, (err, rs) => {
          if (err || !rs) return reject(err);
          fs.promises
            .mkdir(path.dirname(dest), { recursive: true })
            .then(() => {
              const ws = fs.createWriteStream(dest);
              rs.pipe(ws);
              ws.on('finish', () => {
                out.push(e.fileName);
                totalBytes += e.uncompressedSize;
                zip.readEntry();
              });
              ws.on('error', reject);
            })
            .catch(reject);
        });
      } catch (err) {
        reject(err);
      }
    });
    zip.on('end', () => resolve());
    zip.on('error', reject);
    zip.readEntry();
  });

  return { files: out, totalBytes };
}
```

- [ ] **Step 4: Run** — `pnpm test test/engine/zip-safe.test.ts` → all PASS.

- [ ] **Step 5: Commit** — `feat(packages): zip-safe extractor with zip-slip / symlink / reserved name guards`

---

### Task 12: Payload sha256 + Ed25519 signature verifier

**Files:**
- Create: `src/main/packages/payload-hash.ts`, `src/main/packages/signature.ts`, `test/engine/signature.test.ts`, `test/helpers/key-fixtures.ts`, `scripts/generate-dev-keys.ts`

- [ ] **Step 1: `scripts/generate-dev-keys.ts`** (run once during local dev)

```ts
import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as ed from '@noble/ed25519';

async function main() {
  const priv = ed.utils.randomPrivateKey();
  const pub = await ed.getPublicKeyAsync(priv);
  const out = 'test/fixtures/keys';
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/dev-priv.bin`, Buffer.from(priv));
  writeFileSync(`${out}/dev-pub.bin`, Buffer.from(pub));
  console.log('Wrote', `${out}/dev-priv.bin (gitignored)`, `${out}/dev-pub.bin`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Add to `package.json` scripts: `"gen:dev-keys": "tsx scripts/generate-dev-keys.ts"` (also add `tsx` as dev dep).

- [ ] **Step 2: `test/helpers/key-fixtures.ts`** — generates keys if missing then loads

```ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as ed from '@noble/ed25519';

const PRIV = 'test/fixtures/keys/dev-priv.bin';
const PUB = 'test/fixtures/keys/dev-pub.bin';

let cache: { priv: Uint8Array; pub: Uint8Array } | undefined;

export async function getDevKeys(): Promise<{ priv: Uint8Array; pub: Uint8Array }> {
  if (cache) return cache;
  if (!existsSync(PRIV) || !existsSync(PUB)) {
    mkdirSync('test/fixtures/keys', { recursive: true });
    const priv = ed.utils.randomPrivateKey();
    const pub = await ed.getPublicKeyAsync(priv);
    writeFileSync(PRIV, Buffer.from(priv));
    writeFileSync(PUB, Buffer.from(pub));
  }
  cache = {
    priv: readFileSync(PRIV),
    pub: readFileSync(PUB),
  };
  return cache;
}
```

- [ ] **Step 3: Tests**

`test/engine/signature.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import { verifySignature } from '@main/packages/signature';
import { getDevKeys } from '../helpers/key-fixtures';

describe('verifySignature', () => {
  it('accepts a valid signature', async () => {
    const { priv, pub } = await getDevKeys();
    const msg = Buffer.from('hello world');
    const sig = await ed.signAsync(msg, priv);
    expect(await verifySignature({ message: msg, signature: sig, publicKey: pub })).toBe(true);
  });

  it('rejects a tampered message', async () => {
    const { priv, pub } = await getDevKeys();
    const msg = Buffer.from('hello world');
    const sig = await ed.signAsync(msg, priv);
    const tampered = Buffer.from('hello world!');
    expect(await verifySignature({ message: tampered, signature: sig, publicKey: pub })).toBe(false);
  });

  it('rejects bad signature length', async () => {
    const { pub } = await getDevKeys();
    expect(
      await verifySignature({ message: Buffer.from('x'), signature: Buffer.from('short'), publicKey: pub }),
    ).toBe(false);
  });
});
```

- [ ] **Step 4: Implement `src/main/packages/signature.ts`**

```ts
import * as ed from '@noble/ed25519';

export interface VerifyInput {
  message: Uint8Array;
  signature: Uint8Array;
  publicKey: Uint8Array;
}

export async function verifySignature(input: VerifyInput): Promise<boolean> {
  if (input.signature.length !== 64) return false;
  if (input.publicKey.length !== 32) return false;
  try {
    return await ed.verifyAsync(input.signature, input.message, input.publicKey);
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Implement `src/main/packages/payload-hash.ts`**

```ts
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

export async function streamSha256(stream: Readable): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

export function bufferSha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
```

- [ ] **Step 6: Run** — `pnpm test test/engine/signature.test.ts` → PASS.

- [ ] **Step 7: Commit** — `feat(packages): Ed25519 signature verifier + payload hash`

---

## Phase G — .vdxpkg parsing (Task 13)

### Task 13: Parse + verify a .vdxpkg sideload bundle

**Files:**
- Create: `src/main/packages/vdxpkg.ts`, `test/engine/vdxpkg.test.ts`, `test/helpers/make-vdxpkg.ts`

- [ ] **Step 1: `test/helpers/make-vdxpkg.ts`**

```ts
import * as ed from '@noble/ed25519';
import { makeZip } from './make-zip';
import { getDevKeys } from './key-fixtures';
import { bufferSha256 } from '@main/packages/payload-hash';
import type { Manifest } from '@shared/schema';

export async function makeVdxpkg(input: {
  manifest: Omit<Manifest, 'payload'> & { payload?: Manifest['payload'] };
  payloadFiles: Record<string, string | Buffer>;
}): Promise<{ vdxpkgBytes: Buffer; manifestBytes: Buffer; payloadBytes: Buffer; sigBytes: Buffer }> {
  const payloadBytes = await makeZip(input.payloadFiles);
  const manifest: Manifest = {
    ...(input.manifest as Manifest),
    payload: {
      filename: 'payload.zip',
      sha256: bufferSha256(payloadBytes),
      compressedSize: payloadBytes.length,
    },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const { priv } = await getDevKeys();
  const sigBytes = Buffer.from(await ed.signAsync(manifestBytes, priv));
  const vdxpkgBytes = await makeZip({
    'manifest.json': manifestBytes,
    'manifest.json.sig': sigBytes,
    'payload.zip': payloadBytes,
  });
  return { vdxpkgBytes, manifestBytes, payloadBytes, sigBytes };
}
```

- [ ] **Step 2: Tests**

```ts
import { describe, it, expect } from 'vitest';
import { parseVdxpkg } from '@main/packages/vdxpkg';
import { makeVdxpkg } from '../helpers/make-vdxpkg';
import { getDevKeys } from '../helpers/key-fixtures';

const makeBaseManifest = () => ({
  schemaVersion: 1 as const,
  id: 'com.samsung.vdx.test',
  name: { default: 'Test' },
  version: '1.0.0',
  publisher: 'Samsung',
  description: { default: 'd' },
  size: { download: 1, installed: 2 },
  minHostVersion: '1.0.0',
  targets: { os: 'win32' as const, arch: ['x64' as const] },
  installScope: { supports: ['user' as const], default: 'user' as const },
  requiresReboot: false,
  wizard: [{ type: 'summary' as const }],
  install: { extract: [{ from: '**/*', to: '{{installPath}}' }] },
  postInstall: [],
  uninstall: { removePaths: [], removeShortcuts: true, removeEnvPath: true },
});

describe('parseVdxpkg', () => {
  it('parses and verifies a valid bundle', async () => {
    const { vdxpkgBytes } = await makeVdxpkg({
      manifest: makeBaseManifest() as never,
      payloadFiles: { 'a.txt': 'hi' },
    });
    const { pub } = await getDevKeys();
    const r = await parseVdxpkg(vdxpkgBytes, pub);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.manifest.id).toBe('com.samsung.vdx.test');
      expect(r.value.payloadBytes.length).toBeGreaterThan(0);
      expect(r.value.signatureValid).toBe(true);
    }
  });

  it('rejects when payload sha256 does not match manifest', async () => {
    const { vdxpkgBytes } = await makeVdxpkg({
      manifest: { ...makeBaseManifest(), payload: { filename: 'payload.zip', sha256: 'a'.repeat(64), compressedSize: 1 } } as never,
      payloadFiles: { 'a.txt': 'hi' },
    });
    const { pub } = await getDevKeys();
    const r = await parseVdxpkg(vdxpkgBytes, pub);
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 3: Implement `src/main/packages/vdxpkg.ts`**

```ts
import { Volume, createFsFromVolume } from 'memfs';
import { ManifestSchema, type Manifest } from '@shared/schema';
import { extractZipSafe } from './zip-safe';
import { verifySignature } from './signature';
import { bufferSha256 } from './payload-hash';
import { ok, err, type Result } from '@shared/types';

export interface ParsedVdxpkg {
  manifest: Manifest;
  payloadBytes: Buffer;
  signatureValid: boolean;
}

export async function parseVdxpkg(
  vdxpkgBytes: Buffer,
  publicKey: Uint8Array,
): Promise<Result<ParsedVdxpkg, string>> {
  const tmp = createFsFromVolume(new Volume());
  await tmp.promises.mkdir('/tmp', { recursive: true });
  try {
    await extractZipSafe({ zipBytes: vdxpkgBytes, destDir: '/tmp', fs: tmp });
  } catch (e) {
    return err(`vdxpkg outer extract failed: ${(e as Error).message}`);
  }
  const need = ['/tmp/manifest.json', '/tmp/manifest.json.sig', '/tmp/payload.zip'];
  for (const p of need) {
    try { await tmp.promises.stat(p); }
    catch { return err(`vdxpkg missing required entry: ${p}`); }
  }
  const manifestBytes = (await tmp.promises.readFile('/tmp/manifest.json')) as Buffer;
  const sigBytes = (await tmp.promises.readFile('/tmp/manifest.json.sig')) as Buffer;
  const payloadBytes = (await tmp.promises.readFile('/tmp/payload.zip')) as Buffer;

  const sigValid = await verifySignature({ message: manifestBytes, signature: sigBytes, publicKey });
  let manifest: Manifest;
  try {
    manifest = ManifestSchema.parse(JSON.parse(manifestBytes.toString('utf-8')));
  } catch (e) {
    return err(`manifest invalid: ${(e as Error).message}`);
  }
  if (bufferSha256(payloadBytes) !== manifest.payload.sha256) {
    return err('payload sha256 mismatch with manifest.payload.sha256');
  }
  return ok({ manifest, payloadBytes, signatureValid: sigValid });
}
```

- [ ] **Step 4: Run** — `pnpm test test/engine/vdxpkg.test.ts` → PASS.

- [ ] **Step 5: Commit** — `feat(packages): .vdxpkg parser with signature + payload hash verification`

---

> **End of Part 2.** Continue with `2026-05-01-vdx-installer-phase1-engine-core-part3.md` for Tasks 14-22 (transactions, post-install actions, install/uninstall, validation, state store).
