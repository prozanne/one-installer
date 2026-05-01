import * as ed from '@noble/ed25519';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
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

// ---------------------------------------------------------------------------
// Additional helpers for the test infrastructure
// ---------------------------------------------------------------------------

/** Recursively collect all files in a directory as { relativePath -> Buffer }. */
async function collectDir(dir: string): Promise<Record<string, Buffer>> {
  const result: Record<string, Buffer> = {};
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        const rel = relative(dir, full).replace(/\\/g, '/');
        result[rel] = await readFile(full);
      }
    }
  }
  await walk(dir);
  return result;
}

export interface MakeVdxpkgFromDirOpts {
  /** Absolute path to the payload directory whose files will be zipped. */
  payloadDir: string;
  /** Base manifest (payload field will be computed and injected). */
  manifest: Omit<Manifest, 'payload'>;
}

/**
 * Build a signed .vdxpkg Buffer from a fixture directory + a manifest object.
 * Payload hash and size are computed automatically and injected into the manifest.
 */
export async function makeVdxpkgFromDir(opts: MakeVdxpkgFromDirOpts): Promise<Buffer> {
  const payloadFiles = await collectDir(opts.payloadDir);
  const { vdxpkgBytes } = await makeVdxpkg({ manifest: opts.manifest, payloadFiles });
  return vdxpkgBytes;
}

export interface MakeVdxpkgFromManifestOpts {
  manifest: Omit<Manifest, 'payload'>;
  /** Absolute path to the payload directory. */
  payloadDir: string;
}

/**
 * Alias for makeVdxpkgFromDir with a named-argument style matching the spec.
 */
export async function makeVdxpkgFromManifest(opts: MakeVdxpkgFromManifestOpts): Promise<Buffer> {
  return makeVdxpkgFromDir({ payloadDir: opts.payloadDir, manifest: opts.manifest });
}

/**
 * Build an UNSIGNED .vdxpkg (manifest.json.sig entry contains 64 zero bytes).
 * Useful for testing signature-validation rejection paths.
 */
export async function makeUnsignedVdxpkg(opts: MakeVdxpkgFromDirOpts): Promise<Buffer> {
  const payloadFiles = await collectDir(opts.payloadDir);
  const payloadBytes = await makeZip(payloadFiles);
  const manifest: Manifest = {
    ...(opts.manifest as Manifest),
    payload: {
      filename: 'payload.zip',
      sha256: bufferSha256(payloadBytes),
      compressedSize: payloadBytes.length,
    },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  // sig is all zeros — structurally present but cryptographically invalid
  const fakeSig = Buffer.alloc(64, 0);
  return makeZip({
    'manifest.json': manifestBytes,
    'manifest.json.sig': fakeSig,
    'payload.zip': payloadBytes,
  });
}

/**
 * Build a .vdxpkg whose manifest.json.sig is random bytes (bad signature).
 * Useful for testing the "tampered manifest" rejection path.
 */
export async function makeBadlySignedVdxpkg(opts: MakeVdxpkgFromDirOpts): Promise<Buffer> {
  const payloadFiles = await collectDir(opts.payloadDir);
  const payloadBytes = await makeZip(payloadFiles);
  const manifest: Manifest = {
    ...(opts.manifest as Manifest),
    payload: {
      filename: 'payload.zip',
      sha256: bufferSha256(payloadBytes),
      compressedSize: payloadBytes.length,
    },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  // Deliberately random 64 bytes — will always fail Ed25519 verify
  const randomSig = Buffer.from(ed.utils.randomPrivateKey().slice(0, 32));
  const paddedSig = Buffer.concat([randomSig, randomSig]); // 64 bytes
  return makeZip({
    'manifest.json': manifestBytes,
    'manifest.json.sig': paddedSig,
    'payload.zip': payloadBytes,
  });
}
