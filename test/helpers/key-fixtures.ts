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
    priv: new Uint8Array(readFileSync(PRIV)),
    pub: new Uint8Array(readFileSync(PUB)),
  };
  return cache;
}
