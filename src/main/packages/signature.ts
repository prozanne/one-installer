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
