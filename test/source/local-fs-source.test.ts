/**
 * test/source/local-fs-source.test.ts
 *
 * Tests for LocalFsSource — the Phase 1.0 source implementation.
 * Uses real tmpdir (memfs does not fully support fs.open/read API surface needed
 * for streaming reads on all Node versions).
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as nodeFsPromises from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalFsSource } from '@main/source/local-fs-source';
import { buildSourceTree } from '../helpers/build-source-tree';

let tmpDir: string;

function getSourceError(e: unknown) {
  if (e instanceof Error && (e as unknown as Record<string, unknown>)['sourceError']) {
    return (e as unknown as Record<string, unknown>)['sourceError'] as Record<string, unknown>;
  }
  return null;
}

beforeEach(async () => {
  tmpDir = await nodeFsPromises.mkdtemp(path.join(os.tmpdir(), 'vdx-lfs-test-'));

  // Adapt real fs to FsLike interface
  const fsl = {
    mkdir: (p: string, opts: { recursive: boolean }) => nodeFsPromises.mkdir(p, opts),
    writeFile: (p: string, data: Buffer | Uint8Array) => nodeFsPromises.writeFile(p, data),
  };
  await buildSourceTree(tmpDir, fsl);
});

afterEach(async () => {
  await nodeFsPromises.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Catalog round-trip
// ---------------------------------------------------------------------------
describe('LocalFsSource — fetchCatalog', () => {
  it('returns catalog body + sig on first fetch', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    const result = await src.fetchCatalog();
    expect(result.notModified).toBe(false);
    expect(result.body).toBeInstanceOf(Uint8Array);
    expect(result.sig).toBeInstanceOf(Uint8Array);
    expect(result.etag).toBeDefined();
  });

  it('returns notModified when etag matches mtime+size', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    const first = await src.fetchCatalog();
    expect(first.notModified).toBe(false);
    const second = await src.fetchCatalog({ etag: first.etag });
    expect(second.notModified).toBe(true);
  });

  it('returns fresh data when etag does not match', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    const result = await src.fetchCatalog({ etag: '"stale-etag"' });
    expect(result.notModified).toBe(false);
    expect(result.body).toBeInstanceOf(Uint8Array);
  });

  it('throws NotFoundError when catalog.json is absent', async () => {
    await nodeFsPromises.rm(path.join(tmpDir, 'catalog.json'));
    const src = new LocalFsSource({ rootPath: tmpDir });
    await expect(src.fetchCatalog()).rejects.toMatchObject({
      message: expect.stringContaining(''),
    });
    try {
      await src.fetchCatalog();
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('NotFoundError');
    }
  });

  it('respects AbortSignal — throws if already aborted', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    const ctrl = new AbortController();
    ctrl.abort(new Error('aborted'));
    await expect(src.fetchCatalog({ signal: ctrl.signal })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. fetchManifest happy path
// ---------------------------------------------------------------------------
describe('LocalFsSource — fetchManifest', () => {
  it('returns manifest body + sig', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    const result = await src.fetchManifest('com.samsung.vdx.exampleapp', '1.0.0');
    expect(result.body).toBeInstanceOf(Uint8Array);
    expect(result.sig).toBeInstanceOf(Uint8Array);
    const json = JSON.parse(Buffer.from(result.body).toString('utf-8'));
    expect(json.id).toBe('com.samsung.vdx.exampleapp');
    expect(json.version).toBe('1.0.0');
  });

  it('throws NotFoundError for missing version', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    try {
      await src.fetchManifest('com.samsung.vdx.exampleapp', '9.9.9');
      expect.fail('should have thrown');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('NotFoundError');
    }
  });

  it('throws InvalidResponseError for invalid appId (..)', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    try {
      await src.fetchManifest('..', '1.0.0');
      expect.fail('should have thrown');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('InvalidResponseError');
    }
  });

  it('throws InvalidResponseError for invalid version (non-semver)', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    try {
      await src.fetchManifest('com.samsung.vdx.exampleapp', 'not-semver');
      expect.fail('should have thrown');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('InvalidResponseError');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. fetchPayload streaming
// ---------------------------------------------------------------------------
describe('LocalFsSource — fetchPayload', () => {
  it('streams the full payload as Uint8Array chunks', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    const chunks: Uint8Array[] = [];
    for await (const chunk of src.fetchPayload('com.samsung.vdx.exampleapp', '1.0.0')) {
      expect(chunk).toBeInstanceOf(Uint8Array);
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('supports range requests [start, end)', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    // First get full payload to know its size
    const fullChunks: Uint8Array[] = [];
    for await (const chunk of src.fetchPayload('com.samsung.vdx.exampleapp', '1.0.0')) {
      fullChunks.push(chunk);
    }
    const fullSize = fullChunks.reduce((n, c) => n + c.length, 0);
    expect(fullSize).toBeGreaterThan(10);

    // Now fetch the first 10 bytes
    const rangeChunks: Uint8Array[] = [];
    for await (const chunk of src.fetchPayload('com.samsung.vdx.exampleapp', '1.0.0', {
      range: { start: 0, end: 10 },
    })) {
      rangeChunks.push(chunk);
    }
    const rangeBytes = rangeChunks.reduce((n, c) => n + c.length, 0);
    expect(rangeBytes).toBe(10);
  });

  it('each chunk is ≤ 1 MiB (CAP_PAYLOAD_CHUNK)', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    for await (const chunk of src.fetchPayload('com.samsung.vdx.exampleapp', '1.0.0')) {
      expect(chunk.length).toBeLessThanOrEqual(1024 * 1024);
    }
  });

  it('throws NotFoundError for non-existent payload', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    try {
      for await (const _ of src.fetchPayload('com.samsung.vdx.exampleapp', '9.9.9')) {
        // consume
      }
      expect.fail('should have thrown');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('NotFoundError');
    }
  });

  it('respects pre-aborted AbortSignal — throws immediately', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    const ctrl = new AbortController();
    ctrl.abort(new Error('pre-aborted'));

    let threw = false;
    try {
      for await (const _ of src.fetchPayload('com.samsung.vdx.exampleapp', '1.0.0', { signal: ctrl.signal })) {
        // should not reach here
      }
    } catch {
      threw = true;
    }
    // The impl checks signal?.throwIfAborted() at the top of each next() call.
    // A pre-aborted signal should throw on the first next() call.
    expect(threw).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. ETag mtime semantics
// ---------------------------------------------------------------------------
describe('LocalFsSource — ETag mtime semantics', () => {
  it('ETag changes after file is replaced with different content', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    const first = await src.fetchCatalog();

    // Wait a ms, rewrite
    await new Promise((r) => setTimeout(r, 5));
    await nodeFsPromises.writeFile(
      path.join(tmpDir, 'catalog.json'),
      Buffer.from(JSON.stringify({ schemaVersion: 1, updated: 'new' })),
    );

    const second = await src.fetchCatalog();
    expect(second.etag).not.toBe(first.etag);
  });
});

// ---------------------------------------------------------------------------
// 5. Path traversal rejection
// ---------------------------------------------------------------------------
describe('LocalFsSource — path traversal rejection', () => {
  it('rejects ".." in appId for fetchManifest', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    try {
      await src.fetchManifest('../etc', '1.0.0');
      expect.fail('should throw');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('InvalidResponseError');
    }
  });

  it('rejects ".." in version for fetchManifest', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    try {
      await src.fetchManifest('com.samsung.vdx.exampleapp', '../..');
      expect.fail('should throw');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('InvalidResponseError');
    }
  });

  it('rejects "../../../catalog.json" in assetName for fetchAsset', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    try {
      await src.fetchAsset('com.samsung.vdx.exampleapp', '1.0.0', '../../../catalog.json');
      expect.fail('should throw');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('InvalidResponseError');
    }
  });

  it('rejects assetName starting with /', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    try {
      await src.fetchAsset('com.samsung.vdx.exampleapp', '1.0.0', '/etc/passwd');
      expect.fail('should throw');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('InvalidResponseError');
    }
  });
});

// ---------------------------------------------------------------------------
// 6. fetchAsset happy path
// ---------------------------------------------------------------------------
describe('LocalFsSource — fetchAsset', () => {
  it('fetches icon.png', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    const data = await src.fetchAsset('com.samsung.vdx.exampleapp', '1.0.0', 'icon.png');
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.length).toBeGreaterThan(0);
  });

  it('fetches screenshots/01.png (slash in assetName allowed)', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    const data = await src.fetchAsset('com.samsung.vdx.exampleapp', '1.0.0', 'screenshots/01.png');
    expect(data).toBeInstanceOf(Uint8Array);
  });

  it('throws NotFoundError for missing asset', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    try {
      await src.fetchAsset('com.samsung.vdx.exampleapp', '1.0.0', 'missing.png');
      expect.fail('should throw');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('NotFoundError');
    }
  });
});

// ---------------------------------------------------------------------------
// 7. listVersions
// ---------------------------------------------------------------------------
describe('LocalFsSource — listVersions', () => {
  it('returns versions sorted newest-first via directory scan', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    const versions = await src.listVersions!('com.samsung.vdx.exampleapp');
    expect(versions).toContain('1.1.0');
    expect(versions).toContain('1.0.0');
    const idx110 = versions.indexOf('1.1.0');
    const idx100 = versions.indexOf('1.0.0');
    expect(idx110).toBeLessThan(idx100);
  });

  it('returns versions from versions.json when present', async () => {
    await nodeFsPromises.writeFile(
      path.join(tmpDir, 'apps', 'com.samsung.vdx.exampleapp', 'versions.json'),
      JSON.stringify(['1.1.0', '1.0.0']),
    );
    const src = new LocalFsSource({ rootPath: tmpDir });
    const versions = await src.listVersions!('com.samsung.vdx.exampleapp');
    expect(versions).toEqual(['1.1.0', '1.0.0']);
  });

  it('throws NotFoundError for non-existent appId directory', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    try {
      await src.listVersions!('com.samsung.vdx.nonexistent');
      expect.fail('should throw');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('NotFoundError');
    }
  });

  it('filters out non-semver directory names', async () => {
    await nodeFsPromises.mkdir(path.join(tmpDir, 'apps', 'com.samsung.vdx.exampleapp', 'invalid-dir'), { recursive: true });
    const src = new LocalFsSource({ rootPath: tmpDir });
    const versions = await src.listVersions!('com.samsung.vdx.exampleapp');
    expect(versions).not.toContain('invalid-dir');
  });
});
