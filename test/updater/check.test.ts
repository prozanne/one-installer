/**
 * test/updater/check.test.ts
 *
 * Tests for checkForHostUpdate() from src/main/updater/check.ts.
 *
 * The impl uses source.listVersions(SELF_UPDATE_APP_ID, { channel, signal })
 * where SELF_UPDATE_APP_ID = 'com.samsung.vdx.installer'.
 *
 * A minimal stub PackageSource is used — no real filesystem or HTTP needed.
 */

import { describe, it, expect, vi } from 'vitest';
import { checkForHostUpdate } from '@main/updater/check';
import type { PackageSource } from '@shared/source/package-source';
import type { CheckForHostUpdateOpts } from '@main/updater/check';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a stub PackageSource with a configurable listVersions response. */
function makeSource(opts?: {
  listVersions?: (appId: string, listOpts?: { channel?: string; signal?: AbortSignal }) => Promise<string[]>;
}): PackageSource {
  return {
    id: 'local-fs' as const,
    displayName: 'test-stub',
    fetchCatalog: vi.fn().mockResolvedValue({ notModified: true }),
    fetchManifest: vi.fn().mockResolvedValue({ body: new Uint8Array(), sig: new Uint8Array() }),
    fetchPayload: vi.fn().mockReturnValue((async function* () {})()),
    fetchAsset: vi.fn().mockResolvedValue(new Uint8Array()),
    listVersions: opts?.listVersions ?? vi.fn().mockResolvedValue([]),
  };
}

const STABLE_CONFIG = { repo: 'samsung/vdx-installer' } as const;

function baseOpts(overrides?: Partial<CheckForHostUpdateOpts>): CheckForHostUpdateOpts {
  return {
    source: makeSource(),
    selfUpdateConfig: STABLE_CONFIG,
    currentVersion: '1.0.0',
    channel: 'stable',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Up-to-date — same version
// ---------------------------------------------------------------------------
describe('checkForHostUpdate — up-to-date', () => {
  it('returns null when listVersions returns only current version', async () => {
    const source = makeSource({
      listVersions: vi.fn().mockResolvedValue(['1.0.0']),
    });
    const result = await checkForHostUpdate(baseOpts({ source, currentVersion: '1.0.0' }));
    expect(result).toBeNull();
  });

  it('returns null when listVersions returns an empty array', async () => {
    const source = makeSource({ listVersions: vi.fn().mockResolvedValue([]) });
    const result = await checkForHostUpdate(baseOpts({ source }));
    expect(result).toBeNull();
  });

  it('returns null when selfUpdateConfig is null (self-update disabled)', async () => {
    const source = makeSource({ listVersions: vi.fn().mockResolvedValue(['2.0.0']) });
    const result = await checkForHostUpdate(
      baseOpts({ source, selfUpdateConfig: null }),
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Newer version available
// ---------------------------------------------------------------------------
describe('checkForHostUpdate — newer version', () => {
  it('returns UpdateInfo when latest > current', async () => {
    const source = makeSource({
      listVersions: vi.fn().mockResolvedValue(['1.2.0', '1.1.0', '1.0.0']),
    });
    const result = await checkForHostUpdate(
      baseOpts({ source, currentVersion: '1.0.0' }),
    );
    expect(result).not.toBeNull();
    expect(result!.latestVersion).toBe('1.2.0');
    expect(result!.currentVersion).toBe('1.0.0');
    expect(result!.downloadUrl).toMatch(/com\.samsung\.vdx\.installer/);
  });

  it('picks the newest version (first in list) when multiple newer versions exist', async () => {
    const source = makeSource({
      listVersions: vi.fn().mockResolvedValue(['2.0.0', '1.5.0', '1.1.0']),
    });
    const result = await checkForHostUpdate(
      baseOpts({ source, currentVersion: '1.0.0' }),
    );
    expect(result!.latestVersion).toBe('2.0.0');
  });

  it('returns null when latest equals current (not strictly newer)', async () => {
    const source = makeSource({
      listVersions: vi.fn().mockResolvedValue(['1.0.0']),
    });
    const result = await checkForHostUpdate(
      baseOpts({ source, currentVersion: '1.0.0' }),
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Channel filter — passed through to listVersions
// ---------------------------------------------------------------------------
describe('checkForHostUpdate — channel filter', () => {
  it('passes channel to listVersions so source can filter', async () => {
    const listVersions = vi.fn().mockResolvedValue([]);
    const source = makeSource({ listVersions });
    await checkForHostUpdate(baseOpts({ source, channel: 'beta' }));
    expect(listVersions).toHaveBeenCalledWith(
      'com.samsung.vdx.installer',
      expect.objectContaining({ channel: 'beta' }),
    );
  });

  it('passes "stable" channel when channel is stable', async () => {
    const listVersions = vi.fn().mockResolvedValue([]);
    const source = makeSource({ listVersions });
    await checkForHostUpdate(baseOpts({ source, channel: 'stable' }));
    expect(listVersions).toHaveBeenCalledWith(
      'com.samsung.vdx.installer',
      expect.objectContaining({ channel: 'stable' }),
    );
  });
});

// ---------------------------------------------------------------------------
// 4. AbortSignal
// ---------------------------------------------------------------------------
describe('checkForHostUpdate — AbortSignal', () => {
  it('returns null when listVersions swallows the abort (impl is non-fatal on throw)', async () => {
    // The impl catches ALL listVersions errors and returns null.
    // An AbortError thrown from listVersions is therefore swallowed.
    const controller = new AbortController();
    const listVersions = vi.fn().mockImplementation(async (_id: string, opts?: { signal?: AbortSignal }) => {
      opts?.signal?.throwIfAborted();
      return [];
    });
    const source = makeSource({ listVersions });
    controller.abort();
    const result = await checkForHostUpdate(
      baseOpts({ source, signal: controller.signal }),
    );
    // The impl catches listVersions errors → returns null
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. source NetworkError surfaces as null (non-fatal per impl)
// ---------------------------------------------------------------------------
describe('checkForHostUpdate — source error handling', () => {
  it('returns null when listVersions throws (errors are swallowed per impl)', async () => {
    const source = makeSource({
      listVersions: vi.fn().mockRejectedValue(
        Object.assign(new Error('connection refused'), {
          sourceError: { kind: 'NetworkError', message: 'connection refused', retryable: true },
        }),
      ),
    });
    // Per impl: listVersions errors are caught and return null (non-fatal).
    const result = await checkForHostUpdate(baseOpts({ source }));
    expect(result).toBeNull();
  });

  it('returns null when listVersions is undefined on the source', async () => {
    // Strip listVersions to simulate an http-mirror source
    const source = makeSource() as PackageSource & Record<string, unknown>;
    delete source['listVersions'];
    const result = await checkForHostUpdate(baseOpts({ source }));
    expect(result).toBeNull();
  });
});
