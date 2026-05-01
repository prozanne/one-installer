import { Volume, createFsFromVolume, type IFs } from 'memfs';
import { ManifestSchema, type Manifest } from '@shared/schema';
import { extractZipSafe } from './zip-safe';
import { verifySignature } from './signature';
import { bufferSha256 } from './payload-hash';
import { ok, err, type Result } from '@shared/types';

export interface ParsedVdxpkg {
  manifest: Manifest;
  payloadBytes: Buffer;
  signatureValid: boolean;
}

export async function parseVdxpkg(
  vdxpkgBytes: Buffer,
  publicKey: Uint8Array | Uint8Array[],
): Promise<Result<ParsedVdxpkg, string>> {
  const tmp = createFsFromVolume(new Volume()) as unknown as IFs;
  await tmp.promises.mkdir('/tmp', { recursive: true });
  try {
    await extractZipSafe({ zipBytes: vdxpkgBytes, destDir: '/tmp', fs: tmp });
  } catch (e) {
    return err(`vdxpkg outer extract failed: ${(e as Error).message}`);
  }
  const need = ['/tmp/manifest.json', '/tmp/manifest.json.sig', '/tmp/payload.zip'];
  for (const p of need) {
    try {
      await tmp.promises.stat(p);
    } catch {
      return err(`vdxpkg missing required entry: ${p}`);
    }
  }
  const manifestBytes = (await tmp.promises.readFile('/tmp/manifest.json')) as Buffer;
  const sigBytes = (await tmp.promises.readFile('/tmp/manifest.json.sig')) as Buffer;
  const payloadBytes = (await tmp.promises.readFile('/tmp/payload.zip')) as Buffer;

  // Accept either a single pubkey or an array of trust roots — any match wins.
  // This keeps the simple single-key callers (sideload, tests) intact while
  // letting catalog flows pass the full trust-root union.
  const trustRoots = Array.isArray(publicKey) ? publicKey : [publicKey];
  let sigValid = false;
  for (const pk of trustRoots) {
    if (
      await verifySignature({
        message: new Uint8Array(manifestBytes),
        signature: new Uint8Array(sigBytes),
        publicKey: pk,
      })
    ) {
      sigValid = true;
      break;
    }
  }
  let manifest: Manifest;
  try {
    manifest = ManifestSchema.parse(JSON.parse(manifestBytes.toString('utf-8')));
  } catch (e) {
    return err(`manifest invalid: ${(e as Error).message}`);
  }
  if (bufferSha256(payloadBytes) !== manifest.payload.sha256) {
    return err('payload sha256 mismatch with manifest.payload.sha256');
  }
  return ok({ manifest, payloadBytes, signatureValid: sigValid });
}
