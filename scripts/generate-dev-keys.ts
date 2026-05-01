/**
 * Dev-key generator script.
 *
 * Usage: npm run gen:dev-keys
 *
 * Generates a fresh Ed25519 keypair and writes raw bytes to:
 *   test/fixtures/keys/dev-priv.bin  (32 bytes — GITIGNORED, DO NOT COMMIT)
 *   test/fixtures/keys/dev-pub.bin   (32 bytes)
 *
 * Idempotent: if both files already exist, the script skips and prints a message.
 */

import * as ed from '@noble/ed25519';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const KEYS_DIR = resolve(ROOT, 'test/fixtures/keys');
const PRIV_PATH = resolve(KEYS_DIR, 'dev-priv.bin');
const PUB_PATH = resolve(KEYS_DIR, 'dev-pub.bin');

async function main(): Promise<void> {
  if (existsSync(PRIV_PATH) && existsSync(PUB_PATH)) {
    console.log('[gen:dev-keys] Keys already exist — skipping generation.');
    console.log(`  priv: ${PRIV_PATH}`);
    console.log(`  pub:  ${PUB_PATH}`);
    console.log('\n⚠  DO NOT COMMIT dev-priv.bin (already gitignored)');
    return;
  }

  mkdirSync(KEYS_DIR, { recursive: true });

  const priv = ed.utils.randomPrivateKey();
  const pub = await ed.getPublicKeyAsync(priv);

  writeFileSync(PRIV_PATH, Buffer.from(priv));
  writeFileSync(PUB_PATH, Buffer.from(pub));

  console.log('[gen:dev-keys] Generated fresh Ed25519 keypair:');
  console.log(`  priv: ${PRIV_PATH}  (${priv.length} bytes)`);
  console.log(`  pub:  ${PUB_PATH}  (${pub.length} bytes)`);
  console.log('\n⚠  DO NOT COMMIT dev-priv.bin (already gitignored)');
}

main().catch((err: unknown) => {
  console.error('[gen:dev-keys] ERROR:', err);
  process.exit(1);
});
