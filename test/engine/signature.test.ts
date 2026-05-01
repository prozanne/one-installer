import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import { verifySignature } from '@main/packages/signature';
import { getDevKeys } from '../helpers/key-fixtures';

describe('verifySignature', () => {
  it('accepts a valid signature', async () => {
    const { priv, pub } = await getDevKeys();
    const msg = new TextEncoder().encode('hello world');
    const sig = await ed.signAsync(msg, priv);
    expect(await verifySignature({ message: msg, signature: sig, publicKey: pub })).toBe(true);
  });

  it('rejects a tampered message', async () => {
    const { priv, pub } = await getDevKeys();
    const msg = new TextEncoder().encode('hello world');
    const sig = await ed.signAsync(msg, priv);
    const tampered = new TextEncoder().encode('hello world!');
    expect(await verifySignature({ message: tampered, signature: sig, publicKey: pub })).toBe(
      false,
    );
  });

  it('rejects bad signature length', async () => {
    const { pub } = await getDevKeys();
    expect(
      await verifySignature({
        message: new TextEncoder().encode('x'),
        signature: new TextEncoder().encode('short'),
        publicKey: pub,
      }),
    ).toBe(false);
  });
});
