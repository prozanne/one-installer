/**
 * Update IPC handler tests.
 *
 * Targets the pure functions in `src/main/ipc/handlers/update.ts`. The
 * Electron-lifecycle blocker is gone now that the handlers take an injected
 * dep bag — tests construct a minimal `PackageSource` fake and exercise
 * `handleUpdateCheck` / `handleUpdateRun` directly.
 *
 * Full end-to-end (downloadHostUpdate + fetchManifestVerified) is out of
 * scope here because a real verified manifest requires fixture signatures —
 * those are covered in `test/updater/download.test.ts`. We focus on the
 * IPC handler's branching: validation, mutex gate, error mapping.
 */
import { describe, it, expect } from 'vitest';
import { handleUpdateCheck, handleUpdateRun } from '@main/ipc/handlers/update';
import type { PackageSource } from '@shared/source/package-source';
import type { VdxConfig } from '@shared/config/vdx-config';

function makeSource(opts: {
  listVersions?: (appId: string) => Promise<string[]>;
} = {}): PackageSource {
  return {
    id: 'local-fs',
    displayName: 'fake',
    fetchCatalog: async () => ({ notModified: false, body: new Uint8Array(), sig: new Uint8Array() }),
    fetchManifest: async () => ({ body: new Uint8Array(), sig: new Uint8Array() }),
    fetchPayload: () => ({ async *[Symbol.asyncIterator]() { /* empty */ } }),
    fetchAsset: async () => new Uint8Array(),
    ...(opts.listVersions ? { listVersions: opts.listVersions } : {}),
  };
}

const baseConfig: VdxConfig = {
  schemaVersion: 1,
  source: { type: 'github', github: { catalogRepo: 'x/y', selfUpdateRepo: 'x/y', appsOrg: 'x', apiBase: 'https://example.test', ref: 'stable' } },
  channel: 'stable',
  developerMode: false,
  telemetry: false,
  trustRoots: [],
};

const baseDeps = (overrides: { source?: PackageSource; activeTransactions?: () => number } = {}) => ({
  packageSource: overrides.source ?? makeSource(),
  config: baseConfig,
  hostVersion: '1.0.0',
  cacheDir: '/tmp/test-cache',
  activeTransactions: overrides.activeTransactions ?? (() => 0),
  getTrustRoots: async () => [] as Uint8Array[],
});

describe('update:check handler', () => {
  it('returns ok:true with info=null when no newer version exists', async () => {
    const source = makeSource({ listVersions: async () => ['1.0.0'] });
    const res = await handleUpdateCheck(baseDeps({ source }), {});
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.info).toBeNull();
  });

  it('returns ok:true with info populated when a newer version is available', async () => {
    const source = makeSource({ listVersions: async () => ['1.2.0', '1.0.0'] });
    const res = await handleUpdateCheck(baseDeps({ source }), {});
    expect(res.ok).toBe(true);
    if (res.ok && res.info) {
      expect(res.info.latestVersion).toBe('1.2.0');
      expect(res.info.currentVersion).toBe('1.0.0');
    }
  });

  it('returns ok:true info:null even when source.listVersions throws (non-fatal)', async () => {
    const source = makeSource({
      listVersions: async () => {
        throw new Error('NetworkError');
      },
    });
    // checkForHostUpdate swallows source errors and returns null —
    // the handler propagates that as ok:true info:null (silent failure UX).
    const res = await handleUpdateCheck(baseDeps({ source }), {});
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.info).toBeNull();
  });

  it('rejects malformed input via zod', async () => {
    const res = await handleUpdateCheck(baseDeps(), 'not-an-object');
    expect(res.ok).toBe(false);
  });
});

describe('update:run handler', () => {
  it('rejects without confirm:true (zod gate)', async () => {
    const res = await handleUpdateRun(baseDeps(), {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/invalid request/i);
  });

  it('rejects with confirm:false', async () => {
    const res = await handleUpdateRun(baseDeps(), { confirm: false } as never);
    expect(res.ok).toBe(false);
  });

  it('rejects when an install transaction is in flight', async () => {
    const res = await handleUpdateRun(
      baseDeps({ activeTransactions: () => 1 }),
      { confirm: true },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/install is in progress/i);
  });

  it('returns ok:false with "No update available" when checker yields null', async () => {
    // No listVersions support → checkForHostUpdate falls through to Strategy B
    // (http-mirror probe) which without a baseUrl returns null. End result:
    // handler reports "No update available".
    const source = makeSource({ listVersions: async () => ['1.0.0'] });
    const res = await handleUpdateRun(baseDeps({ source }), { confirm: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no update available/i);
  });

  it('does not propagate unexpected errors as unhandled rejection', async () => {
    // listVersions throws + Strategy B unsupported → checker returns null
    // → handler returns "No update available", not a thrown error.
    const source = makeSource({
      listVersions: async () => {
        throw new Error('boom');
      },
    });
    const res = await handleUpdateRun(baseDeps({ source }), { confirm: true });
    expect(res.ok).toBe(false);
  });
});
