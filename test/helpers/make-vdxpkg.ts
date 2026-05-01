import * as ed from '@noble/ed25519';
import { makeZip } from './make-zip';
import { getDevKeys } from './key-fixtures';
import { bufferSha256 } from '@main/packages/payload-hash';
import type { Manifest } from '@shared/schema';

export interface MakeVdxpkgInput {
  manifest: Omit<Manifest, 'payload'> & { payload?: Manifest['payload'] };
  payloadFiles: Record<string, string | Buffer>;
  /** Force a specific payload entry into the manifest (useful for negative tests). */
  payloadOverride?: Manifest['payload'];
}

export async function makeVdxpkg(input: MakeVdxpkgInput): Promise<{
  vdxpkgBytes: Buffer;
  manifestBytes: Buffer;
  payloadBytes: Buffer;
  sigBytes: Buffer;
}> {
  const payloadBytes = await makeZip(input.payloadFiles);
  const manifest: Manifest = {
    ...(input.manifest as Manifest),
    payload: input.payloadOverride ?? {
      filename: 'payload.zip',
      sha256: bufferSha256(payloadBytes),
      compressedSize: payloadBytes.length,
    },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const { priv } = await getDevKeys();
  const sigBytes = Buffer.from(await ed.signAsync(manifestBytes, priv));
  const vdxpkgBytes = await makeZip({
    'manifest.json': manifestBytes,
    'manifest.json.sig': sigBytes,
    'payload.zip': payloadBytes,
  });
  return { vdxpkgBytes, manifestBytes, payloadBytes, sigBytes };
}
