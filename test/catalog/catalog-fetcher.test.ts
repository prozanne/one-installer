/**
 * test/catalog/catalog-fetcher.test.ts
 *
 * Tests for fetchCatalogVerified — fetch, sig verify, zod parse.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as nodeFsPromises from 'node:fs/promises';
import * as ed from '@noble/ed25519';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fetchCatalogVerified } from '@main/catalog/catalog-fetcher';
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
  tmpDir = await nodeFsPromises.mkdtemp(path.join(os.tmpdir(), 'vdx-catalog-test-'));
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

// ---------------------------------------------------------------------------
describe('fetchCatalogVerified', () => {
  it('happy path — returns verified catalog', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    const result = await fetchCatalogVerified(src, { trustRoots });
    expect('catalog' in result).toBe(true);
    if ('catalog' in result) {
      expect(result.catalog.schemaVersion).toBe(1);
      expect(Array.isArray(result.catalog.apps)).toBe(true);
      expect(result.catalog.apps.length).toBeGreaterThan(0);
    }
  });

  it('returns { notModified: true } when etag matches', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    const first = await fetchCatalogVerified(src, { trustRoots });
    expect('catalog' in first).toBe(true);
    const etag = 'etag' in first ? first.etag : undefined;
    expect(etag).toBeDefined();

    const second = await fetchCatalogVerified(src, { trustRoots, cachedEtag: etag });
    expect('notModified' in second && second.notModified).toBe(true);
  });

  it('throws Error on signature verification failure', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    // Use a different public key (verification should fail)
    const wrongKey = new Uint8Array(32).fill(0x42);
    // Generate a valid-format wrong key
    const privKey = ed.utils.randomPrivateKey();
    const wrongPub = await ed.getPublicKeyAsync(privKey);

    await expect(
      fetchCatalogVerified(src, { trustRoots: [wrongPub] }),
    ).rejects.toThrow(/signature/i);
  });

  it('throws Error on zod schema validation failure for malformed catalog body', async () => {
    // Write invalid catalog JSON (not matching CatalogSchema)
    const badCatalog = JSON.stringify({ schemaVersion: 99, apps: 'not-an-array' });
    const { priv } = await getDevKeys();
    const bodyBytes = Buffer.from(badCatalog);
    const sig = await ed.signAsync(new Uint8Array(bodyBytes), priv);
    await nodeFsPromises.writeFile(path.join(tmpDir, 'catalog.json'), bodyBytes);
    await nodeFsPromises.writeFile(path.join(tmpDir, 'catalog.json.sig'), Buffer.from(sig));

    const src = new LocalFsSource({ rootPath: tmpDir });
    await expect(
      fetchCatalogVerified(src, { trustRoots }),
    ).rejects.toThrow(/schema/i);
  });

  it('surfaces SourceError unchanged (NotFoundError from source)', async () => {
    await nodeFsPromises.rm(path.join(tmpDir, 'catalog.json'));
    const src = new LocalFsSource({ rootPath: tmpDir });
    try {
      await fetchCatalogVerified(src, { trustRoots });
      expect.fail('should throw');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('NotFoundError');
    }
  });

  it('etag is passed back in result when catalog was fetched', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    const result = await fetchCatalogVerified(src, { trustRoots });
    if ('catalog' in result) {
      expect(result.etag).toBeDefined();
    }
  });
});
