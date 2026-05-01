import { describe, it, expect, vi } from 'vitest';
import {
  handleAppsCheckUpdates,
  handleAppsUpdateRun,
  type AppsUpdateHandlerDeps,
} from '@main/ipc/handlers/apps-update';
import type { CatalogT, InstalledStateT, Manifest } from '@shared/schema';

const fakeManifest = (): Manifest =>
  ({
    schemaVersion: 1,
    id: 'com.samsung.vdx.x',
    name: { default: 'X App' },
    version: '1.0.0',
    publisher: 'Samsung',
    description: { default: 'd' },
    size: { download: 1, installed: 1 },
    payload: { filename: 'p.zip', sha256: 'a'.repeat(64), compressedSize: 1 },
    minHostVersion: '0.1.0',
    targets: { os: 'win32', arch: ['x64'] },
    installScope: { supports: ['user'], default: 'user' },
    requiresReboot: false,
    wizard: [{ type: 'summary' }],
    install: { extract: [{ from: '**/*', to: '{{installPath}}' }] },
    postInstall: [],
    uninstall: { removePaths: [], removeShortcuts: true, removeEnvPath: true },
  }) as Manifest;

const installedAt = '2026-04-30T00:00:00.000Z';

const makeInstalled = (
  overrides: Partial<InstalledStateT['apps'][string]> = {},
): InstalledStateT['apps'] => ({
  'com.samsung.vdx.x': {
    version: '1.0.0',
    installScope: 'user',
    installPath: '/Apps/X',
    wizardAnswers: {},
    journal: [],
    manifestSnapshot: fakeManifest(),
    installedAt,
    updateChannel: 'stable',
    autoUpdate: 'ask',
    source: 'catalog',
    kind: 'app',
    ...overrides,
  },
});

const makeCatalog = (latestVersion = '1.1.0'): CatalogT => ({
  schemaVersion: 1,
  updatedAt: '2026-05-01T00:00:00.000Z',
  channels: ['stable'],
  categories: [],
  featured: [],
  apps: [
    {
      id: 'com.samsung.vdx.x',
      displayName: { default: 'X App (catalog)' },
      latestVersion,
      packageUrl: 'https://example.invalid/x.vdxpkg',
      category: 'apps',
      channels: ['stable'],
      tags: [],
      minHostVersion: '0.1.0',
      deprecated: false,
      replacedBy: null,
      addedAt: '2026-04-01T00:00:00.000Z',
    },
  ],
});

const makeDeps = (
  overrides: Partial<AppsUpdateHandlerDeps> = {},
): AppsUpdateHandlerDeps => ({
  readInstalled: async () => makeInstalled(),
  getCatalog: (kind) => (kind === 'app' ? makeCatalog() : null),
  channel: () => 'stable',
  triggerCatalogInstall: async () => ({
    ok: true,
    manifest: fakeManifest(),
    defaultInstallPath: '/Apps/X',
    signatureValid: true,
    sessionId: '00000000-0000-4000-8000-000000000000',
    kind: 'app',
  }),
  ...overrides,
});

describe('handleAppsCheckUpdates', () => {
  it('emits a candidate when the catalog has a newer version', async () => {
    const res = await handleAppsCheckUpdates(makeDeps(), {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.candidates).toHaveLength(1);
      expect(res.candidates[0]).toMatchObject({
        appId: 'com.samsung.vdx.x',
        fromVersion: '1.0.0',
        toVersion: '1.1.0',
        kind: 'app',
        policy: 'ask',
        displayName: 'X App (catalog)',
      });
    }
  });

  it('returns empty list when no catalog is loaded yet', async () => {
    const res = await handleAppsCheckUpdates(
      makeDeps({ getCatalog: () => null }),
      {},
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.candidates).toHaveLength(0);
  });

  it('returns empty list when versions match', async () => {
    const res = await handleAppsCheckUpdates(
      makeDeps({ getCatalog: () => makeCatalog('1.0.0') }),
      {},
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.candidates).toHaveLength(0);
  });

  it('falls back to manifestSnapshot.name when catalog has no displayName', async () => {
    const cat = makeCatalog();
    delete cat.apps[0]!.displayName;
    const res = await handleAppsCheckUpdates(
      makeDeps({ getCatalog: (k) => (k === 'app' ? cat : null) }),
      {},
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.candidates[0]?.displayName).toBe('X App');
  });

  it('routes app vs agent kind through the right catalog', async () => {
    const installed = makeInstalled({ kind: 'agent' });
    const agentCat = makeCatalog();
    const res = await handleAppsCheckUpdates(
      makeDeps({
        readInstalled: async () => installed,
        getCatalog: (k) => (k === 'agent' ? agentCat : null),
      }),
      {},
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.candidates).toHaveLength(1);
      expect(res.candidates[0]?.kind).toBe('agent');
    }
  });
});

describe('handleAppsUpdateRun', () => {
  it('rejects an unknown appId', async () => {
    const res = await handleAppsUpdateRun(makeDeps(), { appId: 'com.does.not.exist' });
    expect(res.ok).toBe(false);
  });

  it('hands off to triggerCatalogInstall and returns its session/manifest', async () => {
    const trigger = vi.fn().mockResolvedValue({
      ok: true,
      manifest: fakeManifest(),
      defaultInstallPath: '/Apps/X',
      signatureValid: true,
      sessionId: '11111111-1111-4111-8111-111111111111',
      kind: 'app' as const,
    });
    const res = await handleAppsUpdateRun(
      makeDeps({ triggerCatalogInstall: trigger }),
      { appId: 'com.samsung.vdx.x' },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.installed).toBe(false);
      expect(res.sessionId).toBe('11111111-1111-4111-8111-111111111111');
    }
    expect(trigger).toHaveBeenCalledWith('app', 'com.samsung.vdx.x');
  });

  it('propagates triggerCatalogInstall failure', async () => {
    const res = await handleAppsUpdateRun(
      makeDeps({
        triggerCatalogInstall: async () => ({ ok: false, error: 'network down' }),
      }),
      { appId: 'com.samsung.vdx.x' },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/network down/);
  });

  it('routes via the installed entry kind, not what the renderer claimed', async () => {
    const trigger = vi.fn().mockResolvedValue({
      ok: true,
      manifest: fakeManifest(),
      defaultInstallPath: '/Apps/X',
      signatureValid: true,
      sessionId: '22222222-2222-4222-8222-222222222222',
      kind: 'agent' as const,
    });
    await handleAppsUpdateRun(
      makeDeps({
        readInstalled: async () => makeInstalled({ kind: 'agent' }),
        triggerCatalogInstall: trigger,
      }),
      { appId: 'com.samsung.vdx.x' },
    );
    // Even though the IPC request didn't carry a kind, the handler reads it
    // from installed.json — this defends against a stale renderer claiming
    // a different kind from what main has on disk.
    expect(trigger).toHaveBeenCalledWith('agent', 'com.samsung.vdx.x');
  });
});
