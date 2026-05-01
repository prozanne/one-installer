/**
 * Pure auth IPC handlers — extracted from `electron-main.ts`.
 *
 * Tokens are stored encrypted via Electron `safeStorage` (Keychain / DPAPI /
 * libsecret). The encrypted blob lives at `paths.authStore`. The handler must
 * never echo the plaintext token back to the renderer — not even a length or
 * a prefix. The renderer's job is to forget the value as soon as the IPC call
 * returns.
 *
 * Tests inject a fake `SafeStorageLike` and a fake `fs` so they can run
 * without an actual Electron / OS keychain.
 */
import {
  AuthSetTokenReq,
  AuthClearTokenReq,
  type AuthSetTokenResT,
  type AuthClearTokenResT,
} from '@shared/ipc-types';
import { ipcError } from '@main/ipc/error';

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
}

export interface AuthFsLike {
  writeFileSync(path: string, data: Buffer, opts?: { mode?: number }): void;
  existsSync(path: string): boolean;
  unlinkSync(path: string): void;
}

export interface AuthHandlerDeps {
  authStorePath: string;
  safeStorage: SafeStorageLike;
  fs: AuthFsLike;
}

export async function handleAuthSetToken(
  deps: AuthHandlerDeps,
  raw: unknown,
): Promise<AuthSetTokenResT> {
  const parsed = AuthSetTokenReq.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'invalid request' };
  // Fail closed: if the OS secure store is unavailable, never fall back to
  // plaintext on disk. The user is told their platform doesn't support it
  // and can decide to use an alternative auth path.
  if (!deps.safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'OS secure storage unavailable on this system' };
  }
  try {
    const encrypted = deps.safeStorage.encryptString(parsed.data.token);
    deps.fs.writeFileSync(deps.authStorePath, encrypted, { mode: 0o600 });
    return { ok: true };
  } catch (e) {
    return ipcError(e);
  }
}

export async function handleAuthClearToken(
  deps: AuthHandlerDeps,
  raw: unknown,
): Promise<AuthClearTokenResT> {
  const parsed = AuthClearTokenReq.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, error: 'invalid request' };
  try {
    if (deps.fs.existsSync(deps.authStorePath)) deps.fs.unlinkSync(deps.authStorePath);
    return { ok: true };
  } catch (e) {
    return ipcError(e);
  }
}
