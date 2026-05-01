import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

/** Compute sha256 of a readable stream; returns lowercase hex. */
export async function streamSha256(stream: Readable): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/** Compute sha256 of a Buffer; returns lowercase hex. */
export function bufferSha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Alias: sha256Stream — spec-required name. */
export const sha256Stream = streamSha256;

/** Alias: sha256Bytes — spec-required name. */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
