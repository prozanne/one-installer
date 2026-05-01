import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

export async function streamSha256(stream: Readable): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

export function bufferSha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
