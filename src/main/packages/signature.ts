import * as ed from '@noble/ed25519';

export interface VerifyInput {
  message: Uint8Array;
  signature: Uint8Array;
  publicKey: Uint8Array;
}

export async function verifySignature(input: VerifyInput): Promise<boolean> {
  if (input.signature.length !== 64) return false;
  if (input.publicKey.length !== 32) return false;
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
