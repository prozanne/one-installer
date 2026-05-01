import { Volume, createFsFromVolume, type IFs } from 'memfs';
import { createHash } from 'node:crypto';
import { buildSystemVars } from './system-paths';
import type {
  ExecInput,
  ExecResult,
  Platform,
  RegHive,
  RegistryValue,
  ShortcutInput,
} from './types';

export interface MockPlatformOptions {
  programFiles?: string;
  localAppData?: string;
  installerVersion?: string;
  diskFreeBytes?: bigint;
  execHandler?: (input: ExecInput) => ExecResult | Promise<ExecResult>;
  /**
   * PIDs the mock should report as alive via `isPidAlive`.
   * Defaults to `[process.pid]` so that a freshly-written lockfile from the
   * current test process is treated as live (matching real-world semantics).
   */
  livePids?: Iterable<number>;
  /**
   * When false (default), HKLM writes throw `PermissionError` to mirror
   * real-Windows behaviour where HKLM requires admin elevation. Tests that
   * exercise machine-scope installs MUST opt in with `elevationGranted: true`
   * so the test fails loudly if the engine ever reaches HKLM without first
   * routing to the elevated worker.
   */
  elevationGranted?: boolean;
}

export class MockPlatform implements Platform {
  readonly fs: IFs;
  readonly registry = new Map<string, Map<string, RegistryValue>>();
  readonly shortcuts = new Map<string, ShortcutInput>();
  readonly userPath: string[] = [];
  readonly machinePath: string[] = [];
  readonly execLog: ExecInput[] = [];
  readonly livePids: Set<number>;
  readonly elevationGranted: boolean;
  private readonly _diskFreeBytes: bigint;
  private readonly _execHandler: NonNullable<MockPlatformOptions['execHandler']>;
  readonly opts: Required<
    Pick<MockPlatformOptions, 'programFiles' | 'localAppData' | 'installerVersion'>
  >;

  constructor(opts: MockPlatformOptions = {}) {
    this.fs = createFsFromVolume(new Volume()) as unknown as IFs;
    this._diskFreeBytes = opts.diskFreeBytes ?? 100n * 1024n * 1024n * 1024n;
    this._execHandler =
      opts.execHandler ??
      (() => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false }));
    this.opts = {
      programFiles: opts.programFiles ?? 'C:/Program Files',
      localAppData: opts.localAppData ?? 'C:/Users/u/AppData/Local',
      installerVersion: opts.installerVersion ?? '0.1.0-dev',
    };
    this.livePids = new Set(opts.livePids ?? [process.pid]);
    this.elevationGranted = opts.elevationGranted ?? false;
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
    return `${hive}::${key.toLowerCase()}`;
  }

  async registryKeyExists(hive: RegHive, key: string): Promise<boolean> {
    const m = this.registry.get(this.regKey(hive, key));
    return !!m && m.size > 0;
  }

  async registryRead(
    hive: RegHive,
    key: string,
    valueName: string,
  ): Promise<RegistryValue | null> {
    return this.registry.get(this.regKey(hive, key))?.get(valueName) ?? null;
  }

  private requireElevationFor(hive: RegHive, op: string): void {
    if (hive === 'HKLM' && !this.elevationGranted) {
      const err = new Error(
        `${op} on HKLM requires elevation (MockPlatform.elevationGranted is false)`,
      );
      err.name = 'PermissionError';
      throw err;
    }
  }

  async registryWrite(
    hive: RegHive,
    key: string,
    valueName: string,
    value: RegistryValue,
  ): Promise<void> {
    this.requireElevationFor(hive, 'registryWrite');
    const k = this.regKey(hive, key);
    let m = this.registry.get(k);
    if (!m) {
      m = new Map();
      this.registry.set(k, m);
    }
    m.set(valueName, value);
  }

  async registryDeleteValue(hive: RegHive, key: string, valueName: string): Promise<void> {
    this.requireElevationFor(hive, 'registryDeleteValue');
    this.registry.get(this.regKey(hive, key))?.delete(valueName);
  }

  async registryDeleteKey(hive: RegHive, key: string, recursive: boolean): Promise<void> {
    this.requireElevationFor(hive, 'registryDeleteKey');
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
    return createHash('sha256').update(buf as Buffer).digest('hex');
  }

  async isProcessRunning(): Promise<{ running: boolean; pid?: number }> {
    return { running: false };
  }

  async isPidAlive(pid: number): Promise<boolean> {
    return this.livePids.has(pid);
  }

  private dirname(p: string): string {
    return p.replace(/\/[^/]*$/, '');
  }
}
