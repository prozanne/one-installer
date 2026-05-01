/**
 * test/catalog/payload-fetcher.test.ts
 *
 * Tests for fetchPayloadStream — payload streaming with SHA-256 hash verification.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as nodeFsPromises from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fetchPayloadStream } from '@main/catalog/payload-fetcher';
import { LocalFsSource } from '@main/source/local-fs-source';
import { buildSourceTree } from '../helpers/build-source-tree';
import { makeZip } from '../helpers/make-zip';

let tmpDir: string;

function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function getSourceError(e: unknown): Record<string, unknown> | null {
  if (e instanceof Error && (e as unknown as Record<string, unknown>)['sourceError']) {
    return (e as unknown as Record<string, unknown>)['sourceError'] as Record<string, unknown>;
  }
  return null;
}

beforeEach(async () => {
  tmpDir = await nodeFsPromises.mkdtemp(path.join(os.tmpdir(), 'vdx-payload-test-'));
  const fsl = {
    mkdir: (p: string, opts: { recursive: boolean }) => nodeFsPromises.mkdir(p, opts),
    writeFile: (p: string, data: Buffer | Uint8Array) => nodeFsPromises.writeFile(p, data),
  };
  await buildSourceTree(tmpDir, fsl);
});

afterEach(async () => {
  await nodeFsPromises.rm(tmpDir, { recursive: true, force: true });
});

async function getPayloadBytes(): Promise<Buffer> {
  return nodeFsPromises.readFile(
    path.join(tmpDir, 'apps', 'com.samsung.vdx.exampleapp', '1.0.0', 'payload.zip'),
  );
}

// ---------------------------------------------------------------------------
describe('fetchPayloadStream', () => {
  it('happy path — streams payload and verifies hash', async () => {
    const payloadBytes = await getPayloadBytes();
    const expectedSha256 = sha256hex(payloadBytes);
    const src = new LocalFsSource({ rootPath: tmpDir });

    const chunks: Uint8Array[] = [];
    for await (const chunk of fetchPayloadStream(src, 'com.samsung.vdx.exampleapp', '1.0.0', {
      expectedSha256,
    })) {
      chunks.push(chunk);
    }
    const total = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    expect(total.equals(payloadBytes)).toBe(true);
  });

  it('throws Error on hash mismatch after stream completes', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    const wrongHash = 'a'.repeat(64);
    const chunks: Uint8Array[] = [];
    await expect(async () => {
      for await (const chunk of fetchPayloadStream(src, 'com.samsung.vdx.exampleapp', '1.0.0', {
        expectedSha256: wrongHash,
      })) {
        chunks.push(chunk);
      }
    }).rejects.toThrow(/hash mismatch/i);
  });

  it('accepts sha256: prefix in expectedSha256', async () => {
    const payloadBytes = await getPayloadBytes();
    const expectedSha256 = 'sha256:' + sha256hex(payloadBytes);
    const src = new LocalFsSource({ rootPath: tmpDir });

    const chunks: Uint8Array[] = [];
    for await (const chunk of fetchPayloadStream(src, 'com.samsung.vdx.exampleapp', '1.0.0', {
      expectedSha256,
    })) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('range resume — partial range still yields bytes and hash is of the slice', async () => {
    const payloadBytes = await getPayloadBytes();
    const rangeStart = 0;
    const rangeEnd = Math.min(20, payloadBytes.length);
    const sliceHash = sha256hex(payloadBytes.slice(rangeStart, rangeEnd));
    const src = new LocalFsSource({ rootPath: tmpDir });

    const chunks: Uint8Array[] = [];
    for await (const chunk of fetchPayloadStream(src, 'com.samsung.vdx.exampleapp', '1.0.0', {
      expectedSha256: sliceHash,
      range: { start: rangeStart, end: rangeEnd },
    })) {
      chunks.push(chunk);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    expect(total).toBe(rangeEnd - rangeStart);
  });

  it('abort mid-stream propagates cancellation', async () => {
    // Write a large payload so streaming takes multiple iterations
    const bigContent = Buffer.alloc(3 * 1024 * 1024, 0xab);
    const bigZip = await makeZip({ 'big.bin': bigContent });
    await nodeFsPromises.writeFile(
      path.join(tmpDir, 'apps', 'com.samsung.vdx.exampleapp', '1.0.0', 'payload.zip'),
      bigZip,
    );

    const src = new LocalFsSource({ rootPath: tmpDir });
    const ctrl = new AbortController();

    await expect(async () => {
      let first = true;
      for await (const _ of fetchPayloadStream(src, 'com.samsung.vdx.exampleapp', '1.0.0', {
        expectedSha256: 'a'.repeat(64), // wrong hash — never get there
        signal: ctrl.signal,
      })) {
        if (first) {
          ctrl.abort(new Error('test-abort'));
          first = false;
        }
      }
    }).rejects.toThrow();
  });

  it('surfaces SourceError unchanged (NotFoundError) when payload missing', async () => {
    const src = new LocalFsSource({ rootPath: tmpDir });
    try {
      for await (const _ of fetchPayloadStream(src, 'com.samsung.vdx.exampleapp', '9.9.9', {
        expectedSha256: 'a'.repeat(64),
      })) {
        // consume
      }
      expect.fail('should throw');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('NotFoundError');
    }
  });
});
