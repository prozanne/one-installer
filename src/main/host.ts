import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as ed from '@noble/ed25519';

export interface HostPaths {
  userData: string;
  installedJson: string;
  cacheDir: string;
  logsDir: string;
  locksDir: string;
  journalDir: string;
  keysDir: string;
}

export function resolveHostPaths(): HostPaths {
  const userData = app.getPath('userData');
  return {
    userData,
    installedJson: join(userData, 'installed.json'),
    cacheDir: join(userData, 'cache'),
    logsDir: join(userData, 'logs'),
    locksDir: join(userData, 'locks'),
    journalDir: join(userData, 'journal'),
    keysDir: join(userData, 'keys'),
  };
}

export async function ensureDevKeyPair(keysDir: string): Promise<{
  pub: Uint8Array;
  priv: Uint8Array;
}> {
  // mode 0o700 on the dir + 0o600 on the private key prevents other accounts
  // on the same machine from reading the dev signing key. Best-effort on
  // platforms (Windows) where POSIX modes don't have the same meaning — but
  // on POSIX hosts (CI/dev) it's enforced.
  mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  const pubPath = join(keysDir, 'dev-pub.bin');
  const privPath = join(keysDir, 'dev-priv.bin');
  if (!existsSync(pubPath) || !existsSync(privPath)) {
    const priv = ed.utils.randomPrivateKey();
    const pub = await ed.getPublicKeyAsync(priv);
    writeFileSync(privPath, Buffer.from(priv), { mode: 0o600 });
    writeFileSync(pubPath, Buffer.from(pub), { mode: 0o644 });
  }
  return {
    priv: new Uint8Array(readFileSync(privPath)),
    pub: new Uint8Array(readFileSync(pubPath)),
  };
}

export const HOST_VERSION = '0.1.0-dev';
