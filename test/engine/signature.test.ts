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

  it('rejects degenerate (low-order) public keys without throwing', async () => {
    // The 32-byte all-zero point is one of Ed25519's small-subgroup elements.
    // A correctly-implemented verifier must return false (not crash, not silently
    // accept) — this guards against an attacker substituting a low-order pubkey
    // to make any signature appear valid.
    const lowOrderPub = new Uint8Array(32); // all zeros
    const fakeSig = new Uint8Array(64); // all zeros — also invalid
    const msg = new TextEncoder().encode('any message');
    const result = await verifySignature({
      message: msg,
      signature: fakeSig,
      publicKey: lowOrderPub,
    });
    expect(result).toBe(false);
  });
});
