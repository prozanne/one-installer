import type { SystemVars } from '@main/engine/template';

export type RegHive = 'HKCU' | 'HKLM';

export interface RegistryValue {
  type: 'REG_SZ' | 'REG_DWORD' | 'REG_QWORD' | 'REG_EXPAND_SZ' | 'REG_MULTI_SZ' | 'REG_BINARY';
  data: string | number | string[];
}

export interface ShortcutInput {
  path: string;
  target: string;
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
  registryKeyExists(hive: RegHive, key: string): Promise<boolean>;
  registryRead(hive: RegHive, key: string, valueName: string): Promise<RegistryValue | null>;
  registryWrite(
    hive: RegHive,
    key: string,
    valueName: string,
    value: RegistryValue,
  ): Promise<void>;
  registryDeleteValue(hive: RegHive, key: string, valueName: string): Promise<void>;
  registryDeleteKey(hive: RegHive, key: string, recursive: boolean): Promise<void>;
  pathEnvAdd(scope: 'user' | 'machine', dir: string): Promise<void>;
  pathEnvRemove(scope: 'user' | 'machine', dir: string): Promise<void>;
  exec(input: ExecInput): Promise<ExecResult>;
  fileSha256(path: string): Promise<string>;
  isProcessRunning(exePath: string): Promise<{ running: boolean; pid?: number }>;
}
