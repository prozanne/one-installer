import * as ed from '@noble/ed25519';

export interface VerifyInput {
  message: Uint8Array;
  signature: Uint8Array;
  publicKey: Uint8Array;
}

/**
 * Reject Ed25519 public keys that lie in the small-order subgroup (cofactor 8).
 * The library's `verify` does NOT do this by default, and a degenerate pubkey
 * (e.g. all-zero bytes, decoded to the identity element) makes the verification
 * equation trivially satisfied — any signature would appear valid against it.
 *
 * `clearCofactor()` returns `[h]A` where h=8 is the curve cofactor. If the
 * result is the identity, A had order dividing 8 — exactly the small-subgroup
 * condition we need to reject.
 */
function isPubkeyLowOrder(pk: Uint8Array): boolean {
  let A: ed.Point;
  try {
    A = ed.Point.fromBytes(pk);
  } catch {
    return true;
  }
  return A.clearCofactor().is0();
}

export async function verifySignature(input: VerifyInput): Promise<boolean> {
  if (input.signature.length !== 64) return false;
  if (input.publicKey.length !== 32) return false;
  if (isPubkeyLowOrder(input.publicKey)) return false;
  try {
    return await ed.verifyAsync(input.signature, input.message, input.publicKey);
  } catch {
    return false;
  }
}

/**
 * Verify a detached Ed25519 signature.
 * Constant-time: rejects wrong-length signature before calling the library.
 */
export async function verifyDetached(
  messageBytes: Uint8Array,
  signatureBytes: Uint8Array,
  pubkeyBytes: Uint8Array,
): Promise<boolean> {
  return verifySignature({ message: messageBytes, signature: signatureBytes, publicKey: pubkeyBytes });
}

/** Load an Ed25519 public key from a base64-encoded string. */
export function loadPubkeyFromBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

/** Load an Ed25519 public key from a raw byte array. */
export function loadPubkeyFromBytes(b: Uint8Array): Uint8Array {
  return new Uint8Array(b);
}
