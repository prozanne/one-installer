import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ed from '@noble/ed25519';

const ROOT = new URL('../..', import.meta.url).pathname;
const PRIV = resolve(ROOT, 'test/fixtures/keys/dev-priv.bin');
const PUB = resolve(ROOT, 'test/fixtures/keys/dev-pub.bin');

let cache: { priv: Uint8Array; pub: Uint8Array } | undefined;

/**
 * Load (or auto-generate) the dev keypair from disk.
 * If the key files are missing, a fresh pair is generated in-place.
 * Results are cached in memory for the lifetime of the process.
 */
export async function getDevKeys(): Promise<{ priv: Uint8Array; pub: Uint8Array }> {
  if (cache) return cache;
  if (!existsSync(PRIV) || !existsSync(PUB)) {
    mkdirSync(resolve(ROOT, 'test/fixtures/keys'), { recursive: true });
    const priv = ed.utils.randomPrivateKey();
    const pub = await ed.getPublicKeyAsync(priv);
    writeFileSync(PRIV, Buffer.from(priv));
    writeFileSync(PUB, Buffer.from(pub));
  }
  cache = {
    priv: new Uint8Array(readFileSync(PRIV)),
    pub: new Uint8Array(readFileSync(PUB)),
  };
  return cache;
}

/**
 * Load the dev keypair from disk. Throws a clear error if the key files are
 * missing, with a hint to run `npm run gen:dev-keys`.
 *
 * Unlike `getDevKeys`, this variant does NOT auto-generate missing keys —
 * it is intended for use in tests that require pre-generated keys.
 */
export async function loadDevKeys(): Promise<{ priv: Uint8Array; pub: Uint8Array }> {
  if (cache) return cache;
  if (!existsSync(PRIV) || !existsSync(PUB)) {
    throw new Error(
      `Dev key files not found.\n` +
        `  Expected: ${PRIV}\n` +
        `             ${PUB}\n` +
        `  Run: npm run gen:dev-keys`,
    );
  }
  cache = {
    priv: new Uint8Array(readFileSync(PRIV)),
    pub: new Uint8Array(readFileSync(PUB)),
  };
  return cache;
}
