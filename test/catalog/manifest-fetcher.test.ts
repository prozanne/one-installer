/**
 * test/catalog/manifest-fetcher.test.ts
 *
 * Tests for fetchManifestVerified — fetch, sig verify, zod parse.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as nodeFsPromises from 'node:fs/promises';
import * as ed from '@noble/ed25519';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fetchManifestVerified } from '@main/catalog/manifest-fetcher';
import { LocalFsSource } from '@main/source/local-fs-source';
import { buildSourceTree } from '../helpers/build-source-tree';
import { getDevKeys } from '../helpers/key-fixtures';

let tmpDir: string;
let trustRoots: Uint8Array[];

function getSourceError(e: unknown): Record<string, unknown> | null {
  if (e instanceof Error && (e as unknown as Record<string, unknown>)['sourceError']) {
    return (e as unknown as Record<string, unknown>)['sourceError'] as Record<string, unknown>;
  }
  return null;
}

beforeEach(async () => {
  tmpDir = await nodeFsPromises.mkdtemp(path.join(os.tmpdir(), 'vdx-manifest-test-'));
  const fsl = {
    mkdir: (p: string, opts: { recursive: boolean }) => nodeFsPromises.mkdir(p, opts),
    writeFile: (p: string, data: Buffer | Uint8Array) => nodeFsPromises.writeFile(p, data),
  };
  const result = await buildSourceTree(tmpDir, fsl);
  trustRoots = result.trustRoots;
});

afterEach(async () => {
  await nodeFsPromises.rm(tmpDir, { recursive: true, force: true });
});

describe('fetchManifestVerified', () => {
  it('happy path — returns verified manifest', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    const manifest = await fetchManifestVerified(src, 'com.samsung.vdx.exampleapp', '1.0.0', {
      trustRoots,
    });
    expect(manifest.id).toBe('com.samsung.vdx.exampleapp');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.schemaVersion).toBe(1);
  });

  it('throws Error on signature verification failure', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    const wrongPriv = ed.utils.randomPrivateKey();
    const wrongPub = await ed.getPublicKeyAsync(wrongPriv);

    await expect(
      fetchManifestVerified(src, 'com.samsung.vdx.exampleapp', '1.0.0', {
        trustRoots: [wrongPub],
      }),
    ).rejects.toThrow(/signature/i);
  });

  it('throws Error on zod schema validation failure for malformed manifest', async () => {
    const { priv } = await getDevKeys();
    const badManifest = Buffer.from(JSON.stringify({ schemaVersion: 1, notAManifest: true }));
    const sig = await ed.signAsync(new Uint8Array(badManifest), priv);
    const manifestPath = path.join(tmpDir, 'apps', 'com.samsung.vdx.exampleapp', '1.0.0', 'manifest.json');
    const sigPath = manifestPath + '.sig';
    await nodeFsPromises.writeFile(manifestPath, badManifest);
    await nodeFsPromises.writeFile(sigPath, Buffer.from(sig));

    const src = new LocalFsSource({ rootPath: tmpDir });
    await expect(
      fetchManifestVerified(src, 'com.samsung.vdx.exampleapp', '1.0.0', { trustRoots }),
    ).rejects.toThrow(/schema/i);
  });

  it('surfaces SourceError unchanged (NotFoundError from source)', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    try {
      await fetchManifestVerified(src, 'com.samsung.vdx.exampleapp', '9.9.9', { trustRoots });
      expect.fail('should throw');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('NotFoundError');
    }
  });
});
