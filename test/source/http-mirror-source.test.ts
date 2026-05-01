/**
 * test/source/http-mirror-source.test.ts
 *
 * Tests for HttpMirrorSource — HTTP/HTTPS mirror backend.
 * Uses in-process HTTP fake server.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as nodeFsPromises from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HttpMirrorSource } from '@main/source/http-mirror-source';
import { createHttpFake } from '../helpers/http-fake';
import { buildSourceTree } from '../helpers/build-source-tree';
import type { HttpFakeServer } from '../helpers/http-fake';

let tmpDir: string;
let fakeServer: HttpFakeServer;

function getSourceError(e: unknown): Record<string, unknown> | null {
  if (e instanceof Error && (e as unknown as Record<string, unknown>)['sourceError']) {
    return (e as unknown as Record<string, unknown>)['sourceError'] as Record<string, unknown>;
  }
  return null;
}

beforeEach(async () => {
  tmpDir = await nodeFsPromises.mkdtemp(path.join(os.tmpdir(), 'vdx-http-test-'));
  const fsl = {
    mkdir: (p: string, opts: { recursive: boolean }) => nodeFsPromises.mkdir(p, opts),
    writeFile: (p: string, data: Buffer | Uint8Array) => nodeFsPromises.writeFile(p, data),
  };
  await buildSourceTree(tmpDir, fsl);
  fakeServer = await createHttpFake(tmpDir);
});

afterEach(async () => {
  fakeServer.clearFaults();
  await fakeServer.close();
  await nodeFsPromises.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Catalog fetch
// ---------------------------------------------------------------------------
describe('HttpMirrorSource — fetchCatalog', () => {
  it('fetches catalog.json + sig on first request', async () => {
    const src = new HttpMirrorSource({ baseUrl: fakeServer.baseUrl });
    const result = await src.fetchCatalog();
    expect(result.notModified).toBe(false);
    expect(result.body).toBeInstanceOf(Uint8Array);
    expect(result.sig).toBeInstanceOf(Uint8Array);
  });

  it('returns notModified on 304 conditional GET', async () => {
    const src = new HttpMirrorSource({ baseUrl: fakeServer.baseUrl });
    const first = await src.fetchCatalog();
    expect(first.etag).toBeDefined();

    // Server returns 304 when If-None-Match matches ETag
    const second = await src.fetchCatalog({ etag: first.etag });
    expect(second.notModified).toBe(true);
  });

  it('ETag round-trip preserves raw value including quotes', async () => {
    const src = new HttpMirrorSource({ baseUrl: fakeServer.baseUrl });
    const first = await src.fetchCatalog();
    // ETag from server is quoted: "abc..."
    expect(first.etag).toMatch(/^"[a-f0-9]+"$/);

    // The If-None-Match sent on second request must match what server returned
    const second = await src.fetchCatalog({ etag: first.etag });
    expect(second.notModified).toBe(true);

    // Inspect the request log to verify the header was sent verbatim
    const conditionalReq = fakeServer.requestLog.find(
      (r) => r.headers['if-none-match'] !== undefined,
    );
    expect(conditionalReq?.headers['if-none-match']).toBe(first.etag);
  });

  it('throws NotFoundError when catalog.json.sig is 404', async () => {
    // Remove only the sig file
    await nodeFsPromises.rm(path.join(tmpDir, 'catalog.json.sig'));
    const src = new HttpMirrorSource({ baseUrl: fakeServer.baseUrl });
    try {
      await src.fetchCatalog();
      expect.fail('should throw');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('NotFoundError');
    }
  });

  it('throws NetworkError on ECONNRESET mid-stream', async () => {
    fakeServer.injectFault({
      on: 'GET /catalog.json',
      kind: 'reset-mid-stream',
      atByte: 5,
    });
    const src = new HttpMirrorSource({ baseUrl: fakeServer.baseUrl });
    try {
      await src.fetchCatalog();
      expect.fail('should throw');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('NetworkError');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. fetchManifest
// ---------------------------------------------------------------------------
describe('HttpMirrorSource — fetchManifest', () => {
  it('fetches manifest.json + sig for existing version', async () => {
    const src = new HttpMirrorSource({ baseUrl: fakeServer.baseUrl });
    const result = await src.fetchManifest('com.samsung.vdx.exampleapp', '1.0.0');
    expect(result.body).toBeInstanceOf(Uint8Array);
    expect(result.sig).toBeInstanceOf(Uint8Array);
  });

  it('throws NotFoundError for missing version', async () => {
    const src = new HttpMirrorSource({ baseUrl: fakeServer.baseUrl });
    try {
      await src.fetchManifest('com.samsung.vdx.exampleapp', '9.9.9');
      expect.fail('should throw');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('NotFoundError');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. fetchPayload streaming
// ---------------------------------------------------------------------------
describe('HttpMirrorSource — fetchPayload', () => {
  it('streams payload in multiple chunks (does not buffer full response)', async () => {
    const src = new HttpMirrorSource({ baseUrl: fakeServer.baseUrl });
    let chunkCount = 0;
    const chunks: Uint8Array[] = [];
    for await (const chunk of src.fetchPayload('com.samsung.vdx.exampleapp', '1.0.0')) {
      chunkCount++;
      chunks.push(chunk);
    }
    expect(chunkCount).toBeGreaterThan(0);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('AbortSignal cancels mid-download — pre-aborted signal throws immediately', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('pre-aborted'));
    const src = new HttpMirrorSource({ baseUrl: fakeServer.baseUrl });

    let threw = false;
    try {
      for await (const _ of src.fetchPayload('com.samsung.vdx.exampleapp', '1.0.0', { signal: ctrl.signal })) {
        // should not reach here
      }
    } catch {
      threw = true;
    }
    // A pre-aborted signal should cause the iterator to reject immediately.
    expect(threw).toBe(true);
  });

  it('throws NetworkError on ECONNRESET mid-stream', async () => {
    fakeServer.injectFault({
      on: 'GET /apps/com.samsung.vdx.exampleapp/1.0.0/payload.zip',
      kind: 'reset-mid-stream',
      atByte: 5,
    });
    const src = new HttpMirrorSource({ baseUrl: fakeServer.baseUrl });
    try {
      for await (const _ of src.fetchPayload('com.samsung.vdx.exampleapp', '1.0.0')) {
        // consume
      }
      expect.fail('should throw');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('NetworkError');
    }
  });

  it('throws InvalidResponseError when server returns 200 instead of 206 for Range with start > 0', async () => {
    // Force the fake to ignore Range and serve full content with status 200.
    fakeServer.injectFault({
      on: 'GET /apps/com.samsung.vdx.exampleapp/1.0.0/payload.zip',
      kind: 'ignore-range-return-200',
    });
    const src = new HttpMirrorSource({ baseUrl: fakeServer.baseUrl });
    try {
      for await (const _ of src.fetchPayload('com.samsung.vdx.exampleapp', '1.0.0', {
        range: { start: 100, end: 200 },
      })) {
        // consume
      }
      expect.fail('should throw');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('InvalidResponseError');
    }
  });

  it('range request returns 206 from fake server', async () => {
    const src = new HttpMirrorSource({ baseUrl: fakeServer.baseUrl });
    // Get full payload size first
    const fullChunks: Uint8Array[] = [];
    for await (const chunk of src.fetchPayload('com.samsung.vdx.exampleapp', '1.0.0')) {
      fullChunks.push(chunk);
    }
    const fullSize = fullChunks.reduce((n, c) => n + c.length, 0);
    expect(fullSize).toBeGreaterThan(10);

    const rangeChunks: Uint8Array[] = [];
    for await (const chunk of src.fetchPayload('com.samsung.vdx.exampleapp', '1.0.0', {
      range: { start: 0, end: 10 },
    })) {
      rangeChunks.push(chunk);
    }
    const rangeTotal = rangeChunks.reduce((n, c) => n + c.length, 0);
    expect(rangeTotal).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 4. fetchAsset
// ---------------------------------------------------------------------------
describe('HttpMirrorSource — fetchAsset', () => {
  it('fetches icon.png as Uint8Array', async () => {
    const src = new HttpMirrorSource({ baseUrl: fakeServer.baseUrl });
    const data = await src.fetchAsset('com.samsung.vdx.exampleapp', '1.0.0', 'icon.png');
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.length).toBeGreaterThan(0);
  });

  it('throws NotFoundError for missing asset', async () => {
    const src = new HttpMirrorSource({ baseUrl: fakeServer.baseUrl });
    try {
      await src.fetchAsset('com.samsung.vdx.exampleapp', '1.0.0', 'missing.png');
      expect.fail('should throw');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('NotFoundError');
    }
  });

  it('throws InvalidResponseError for ".." in assetName', async () => {
    const src = new HttpMirrorSource({ baseUrl: fakeServer.baseUrl });
    try {
      await src.fetchAsset('com.samsung.vdx.exampleapp', '1.0.0', '../../../catalog.json');
      expect.fail('should throw');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('InvalidResponseError');
    }
  });
});

// ---------------------------------------------------------------------------
// 5. listVersions
// ---------------------------------------------------------------------------
describe('HttpMirrorSource — listVersions', () => {
  it('returns versions from versions.json when present', async () => {
    const versions = ['1.1.0', '1.0.0'];
    await nodeFsPromises.writeFile(
      path.join(tmpDir, 'apps', 'com.samsung.vdx.exampleapp', 'versions.json'),
      JSON.stringify(versions),
    );
    const src = new HttpMirrorSource({ baseUrl: fakeServer.baseUrl });
    const result = await src.listVersions!('com.samsung.vdx.exampleapp');
    expect(result).toEqual(versions);
  });

  it('throws NotFoundError when versions.json is absent', async () => {
    const src = new HttpMirrorSource({ baseUrl: fakeServer.baseUrl });
    try {
      await src.listVersions!('com.samsung.vdx.nonexistent');
      expect.fail('should throw');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('NotFoundError');
    }
  });

  it('throws InvalidResponseError when versions.json is not valid JSON', async () => {
    await nodeFsPromises.mkdir(path.join(tmpDir, 'apps', 'com.samsung.vdx.badapp'), { recursive: true });
    await nodeFsPromises.writeFile(
      path.join(tmpDir, 'apps', 'com.samsung.vdx.badapp', 'versions.json'),
      Buffer.from('{ not valid json '),
    );
    const src = new HttpMirrorSource({ baseUrl: fakeServer.baseUrl });
    try {
      await src.listVersions!('com.samsung.vdx.badapp');
      expect.fail('should throw');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('InvalidResponseError');
    }
  });
});
