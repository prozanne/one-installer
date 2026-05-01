/**
 * Windows platform implementation — STUB for Phase 1.0.
 * Real Win32 implementation is deferred to Phase 1.1.
 */
import type { Platform, ExecInput, ShortcutInput, RegHive, RegistryValue } from './types';
import type { SystemVars } from '@main/engine/template';

function notImpl(method: string): never {
  throw new Error(`windows platform not yet implemented in phase 1.0: ${method}`);
}

export const windowsPlatform: Platform = {
  systemVars(): SystemVars {
    return notImpl('systemVars');
  },
  pathExists(_p: string): Promise<boolean> {
    return notImpl('pathExists');
  },
  ensureDir(_p: string): Promise<void> {
    return notImpl('ensureDir');
  },
  rmDir(_p: string, _opts?: { recursive: boolean }): Promise<void> {
    return notImpl('rmDir');
  },
  rmFile(_p: string): Promise<void> {
    return notImpl('rmFile');
  },
  moveFile(_from: string, _to: string, _opts?: { overwrite?: boolean }): Promise<void> {
    return notImpl('moveFile');
  },
  diskFreeBytes(_driveLetter: string): Promise<bigint> {
    return notImpl('diskFreeBytes');
  },
  createShortcut(_input: ShortcutInput): Promise<void> {
    return notImpl('createShortcut');
  },
  deleteShortcut(_path: string): Promise<void> {
    return notImpl('deleteShortcut');
  },
  registryKeyExists(_hive: RegHive, _key: string): Promise<boolean> {
    return notImpl('registryKeyExists');
  },
  registryRead(_hive: RegHive, _key: string, _valueName: string): Promise<RegistryValue | null> {
    return notImpl('registryRead');
  },
  registryWrite(
    _hive: RegHive,
    _key: string,
    _valueName: string,
    _value: RegistryValue,
  ): Promise<void> {
    return notImpl('registryWrite');
  },
  registryDeleteValue(_hive: RegHive, _key: string, _valueName: string): Promise<void> {
    return notImpl('registryDeleteValue');
  },
  registryDeleteKey(_hive: RegHive, _key: string, _recursive: boolean): Promise<void> {
    return notImpl('registryDeleteKey');
  },
  pathEnvAdd(_scope: 'user' | 'machine', _dir: string): Promise<void> {
    return notImpl('pathEnvAdd');
  },
  pathEnvRemove(_scope: 'user' | 'machine', _dir: string): Promise<void> {
    return notImpl('pathEnvRemove');
  },
  exec(_input: ExecInput): Promise<import('./types').ExecResult> {
    return notImpl('exec');
  },
  fileSha256(_path: string): Promise<string> {
    return notImpl('fileSha256');
  },
  isProcessRunning(_exePath: string): Promise<{ running: boolean; pid?: number }> {
    return notImpl('isProcessRunning');
  },
};
