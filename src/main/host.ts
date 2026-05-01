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
  mkdirSync(keysDir, { recursive: true });
  const pubPath = join(keysDir, 'dev-pub.bin');
  const privPath = join(keysDir, 'dev-priv.bin');
  if (!existsSync(pubPath) || !existsSync(privPath)) {
    const priv = ed.utils.randomPrivateKey();
    const pub = await ed.getPublicKeyAsync(priv);
    writeFileSync(privPath, Buffer.from(priv));
    writeFileSync(pubPath, Buffer.from(pub));
  }
  return {
    priv: new Uint8Array(readFileSync(privPath)),
    pub: new Uint8Array(readFileSync(pubPath)),
  };
}

export const HOST_VERSION = '0.1.0-dev';
