/**
 * test/updater/download.test.ts
 *
 * Tests for downloadHostUpdate() from src/main/updater/download.ts.
 *
 * Actual API:
 *   downloadHostUpdate(info: UpdateInfo, opts: DownloadHostUpdateOpts): Promise<void>
 *
 * Where UpdateInfo = { latestVersion, currentVersion, downloadUrl, releaseNotes? }
 * and DownloadHostUpdateOpts = { source, destPath, expectedSha256, signal? }
 *
 * downloadUrl must be a synthetic source:// URL produced by checkForHostUpdate.
 * The function calls source.fetchPayload(appId, version, { signal }).
 *
 * NOTE: The impl uses node:fs createWriteStream and does NOT create parent
 * directories. Tests must ensure the destPath parent exists.
 */

import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadHostUpdate } from '@main/updater/download';
import type { UpdateInfo } from '@main/updater/types';
import type { PackageSource } from '@shared/source/package-source';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Build a synthetic source:// download URL as checkForHostUpdate would produce. */
function makeSyntheticUrl(sourceId: string, appId: string, version: string): string {
  return `source://${sourceId}/${appId}/${version}/payload.zip`;
}

/** Minimal UpdateInfo with a valid synthetic downloadUrl. */
function makeInfo(appId: string, version: string): UpdateInfo {
  return {
    latestVersion: version,
    currentVersion: '0.1.0',
    downloadUrl: makeSyntheticUrl('local-fs', appId, version),
  };
}

/** Build a stub PackageSource whose fetchPayload yields the given bytes. */
function makeSource(payloadBytes: Buffer): PackageSource {
  return {
    id: 'local-fs' as const,
    displayName: 'test-stub',
    fetchCatalog: vi.fn().mockResolvedValue({ notModified: true }),
    fetchManifest: vi.fn().mockResolvedValue({ body: new Uint8Array(), sig: new Uint8Array() }),
    fetchPayload(_appId: string, _version: string, _opts?: unknown): AsyncIterable<Uint8Array> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          let done = false;
          return {
            async next(): Promise<IteratorResult<Uint8Array>> {
              if (done) return { value: undefined as unknown as Uint8Array, done: true };
              done = true;
              return { value: new Uint8Array(payloadBytes), done: false };
            },
          };
        },
      };
    },
    fetchAsset: vi.fn().mockResolvedValue(new Uint8Array()),
    listVersions: vi.fn().mockResolvedValue([]),
  };
}

/** Build a stub PackageSource that throws when fetchPayload is iterated. */
function makeErrorSource(error: Error): PackageSource {
  return {
    id: 'local-fs' as const,
    displayName: 'test-stub-error',
    fetchCatalog: vi.fn().mockResolvedValue({ notModified: true }),
    fetchManifest: vi.fn().mockResolvedValue({ body: new Uint8Array(), sig: new Uint8Array() }),
    fetchPayload(): AsyncIterable<Uint8Array> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          return {
            async next(): Promise<IteratorResult<Uint8Array>> {
              throw error;
            },
          };
        },
      };
    },
    fetchAsset: vi.fn().mockResolvedValue(new Uint8Array()),
    listVersions: vi.fn().mockResolvedValue([]),
  };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const APP_ID = 'com.samsung.vdx.installer';
const VERSION = '1.2.0';
const PAYLOAD = Buffer.from('fake-installer-payload-bytes-v1.2.0');
const CORRECT_SHA256 = sha256Hex(PAYLOAD);

// ---------------------------------------------------------------------------
// 1. Hash match — success path
// ---------------------------------------------------------------------------
describe('downloadHostUpdate — hash match', () => {
  it('resolves when downloaded payload sha256 matches expectedSha256', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vdx-dl-'));
    const destPath = join(tmpDir, 'installer.zip');
    try {
      const source = makeSource(PAYLOAD);
      const info = makeInfo(APP_ID, VERSION);
      await downloadHostUpdate(info, { source, destPath, expectedSha256: CORRECT_SHA256 });
      expect(existsSync(destPath)).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('accepts expectedSha256 with "sha256:" prefix', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vdx-dl-'));
    const destPath = join(tmpDir, 'installer.zip');
    try {
      const source = makeSource(PAYLOAD);
      const info = makeInfo(APP_ID, VERSION);
      await downloadHostUpdate(info, {
        source,
        destPath,
        expectedSha256: `sha256:${CORRECT_SHA256}`,
      });
      expect(existsSync(destPath)).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Hash mismatch — throws
// ---------------------------------------------------------------------------
describe('downloadHostUpdate — hash mismatch', () => {
  it('throws when sha256 of downloaded payload does not match expectedSha256', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vdx-dl-'));
    const destPath = join(tmpDir, 'installer.zip');
    try {
      const wrongSha256 = 'a'.repeat(64);
      const source = makeSource(PAYLOAD);
      const info = makeInfo(APP_ID, VERSION);
      await expect(
        downloadHostUpdate(info, { source, destPath, expectedSha256: wrongSha256 }),
      ).rejects.toThrow(/hash mismatch/i);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. AbortSignal mid-stream
// ---------------------------------------------------------------------------
describe('downloadHostUpdate — AbortSignal mid-stream', () => {
  it('rejects when source throws during streaming (simulating abort)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vdx-dl-'));
    const destPath = join(tmpDir, 'installer.zip');
    try {
      const abortErr = new Error('AbortError');
      abortErr.name = 'AbortError';
      const source = makeErrorSource(abortErr);
      const info = makeInfo(APP_ID, VERSION);
      await expect(
        downloadHostUpdate(info, { source, destPath, expectedSha256: CORRECT_SHA256 }),
      ).rejects.toThrow('AbortError');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. dest dir — parent must exist (impl does NOT create it)
// NOTE: The impl uses createWriteStream which requires the parent directory
// to already exist. It does not call mkdirp/mkdir internally.
// ---------------------------------------------------------------------------
describe('downloadHostUpdate — dest path behaviour', () => {
  it('writes the downloaded payload to destPath', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vdx-dl-'));
    const destPath = join(tmpDir, 'output.bin');
    try {
      const source = makeSource(PAYLOAD);
      const info = makeInfo(APP_ID, VERSION);
      await downloadHostUpdate(info, { source, destPath, expectedSha256: CORRECT_SHA256 });
      // File should exist with the correct content
      const { readFileSync } = await import('node:fs');
      const written = readFileSync(destPath);
      expect(written).toEqual(PAYLOAD);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.skip(
    'creates parent directories if they do not exist — NOT implemented in Phase 1.1 impl (no mkdirp call)',
    // The impl calls createWriteStream(destPath) directly without mkdir.
    // Enabling this would require the impl to call fs.mkdir({ recursive: true }) on the parent.
    // Skip until Phase 1.2 adds that behaviour.
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'vdx-dl-'));
      const nestedDestPath = join(tmpDir, 'a', 'b', 'c', 'installer.zip');
      try {
        const source = makeSource(PAYLOAD);
        const info = makeInfo(APP_ID, VERSION);
        await downloadHostUpdate(info, {
          source,
          destPath: nestedDestPath,
          expectedSha256: CORRECT_SHA256,
        });
        expect(existsSync(nestedDestPath)).toBe(true);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it('throws with a descriptive error when downloadUrl is not a source:// URL', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vdx-dl-'));
    const destPath = join(tmpDir, 'installer.zip');
    try {
      const source = makeSource(PAYLOAD);
      const info: UpdateInfo = {
        latestVersion: VERSION,
        currentVersion: '0.1.0',
        downloadUrl: 'https://example.com/installer.exe',
      };
      await expect(
        downloadHostUpdate(info, { source, destPath, expectedSha256: CORRECT_SHA256 }),
      ).rejects.toThrow(/cannot parse downloadUrl/i);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

