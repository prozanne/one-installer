import { describe, it, expect } from 'vitest';
import { Volume, createFsFromVolume } from 'memfs';
import type * as nodeFs from 'node:fs';
import { handleHostExportState, handleHostImportState } from '@main/ipc/handlers/host-state';
import { createInstalledStore } from '@main/state/installed-store';
import type { Manifest } from '@shared/schema';

type FsLike = typeof nodeFs;

const fakeManifest: Manifest = {
  schemaVersion: 1,
  id: 'com.samsung.vdx.a',
  name: { default: 'A' },
  version: '1.0.0',
  publisher: 'p',
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
} as Manifest;

const placeholder = (id: string): Manifest => ({ ...fakeManifest, id });

function makeStore() {
  const vol = new Volume();
  const fs = createFsFromVolume(vol) as unknown as FsLike;
  return createInstalledStore('/installed.json', fs, '0.1.0');
}

describe('handleHostExportState', () => {
  it('exports installed apps and settings', async () => {
    const store = makeStore();
    await store.update((s) => {
      s.apps['com.samsung.vdx.a'] = {
        version: '1.2.3',
        installScope: 'user',
        installPath: '/i/a',
        wizardAnswers: { foo: 'bar' },
        journal: [],
        manifestSnapshot: fakeManifest,
        installedAt: '2026-04-01T00:00:00.000Z',
        updateChannel: 'beta',
        autoUpdate: 'auto',
        source: 'catalog',
        kind: 'app',
      };
    });
    const r = await handleHostExportState(
      { installedStore: store, hostVersion: '0.1.0', placeholderManifestForId: placeholder },
      {},
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.backup.backupSchema).toBe(1);
      expect(r.backup.apps['com.samsung.vdx.a']).toMatchObject({
        version: '1.2.3',
        wizardAnswers: { foo: 'bar' },
        kind: 'app',
        updateChannel: 'beta',
        autoUpdate: 'auto',
      });
      expect(r.backup.settings).toBeDefined();
    }
  });

  it('omits journal + manifestSnapshot from the export', async () => {
    const store = makeStore();
    await store.update((s) => {
      s.apps['com.samsung.vdx.a'] = {
        version: '1.0.0',
        installScope: 'user',
        installPath: '/i/a',
        wizardAnswers: {},
        journal: [],
        manifestSnapshot: fakeManifest,
        installedAt: '2026-04-01T00:00:00.000Z',
        updateChannel: 'stable',
        autoUpdate: 'ask',
        source: 'catalog',
        kind: 'app',
      };
    });
    const r = await handleHostExportState(
      { installedStore: store, hostVersion: '0.1.0', placeholderManifestForId: placeholder },
      {},
    );
    if (r.ok) {
      const a = r.backup.apps['com.samsung.vdx.a'] as Record<string, unknown>;
      expect(a['manifestSnapshot']).toBeUndefined();
      expect(a['journal']).toBeUndefined();
      expect(a['installPath']).toBeUndefined();
    }
  });
});

describe('handleHostImportState', () => {
  it('merges new entries into installed.json', async () => {
    const store = makeStore();
    const r = await handleHostImportState(
      { installedStore: store, hostVersion: '0.1.0', placeholderManifestForId: placeholder },
      {
        backup: {
          backupSchema: 1,
          exportedAt: '2026-05-01T00:00:00.000Z',
          hostVersion: '0.1.0',
          apps: {
            'com.samsung.vdx.a': {
              version: '1.0.0',
              installScope: 'user',
              wizardAnswers: { foo: 'bar' },
              kind: 'app',
              updateChannel: 'stable',
              autoUpdate: 'ask',
            },
          },
          settings: {
            language: 'ko',
            updateChannel: 'beta',
            autoUpdateHost: 'auto',
            autoUpdateApps: 'auto',
            cacheLimitGb: 10,
            proxy: null,
            telemetry: false,
            trayMode: true,
            developerMode: false,
          },
        },
        reinstall: false,
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.appsMerged).toBe(1);
    const state = await store.read();
    expect(state.apps['com.samsung.vdx.a']?.version).toBe('1.0.0');
    expect(state.apps['com.samsung.vdx.a']?.wizardAnswers).toEqual({ foo: 'bar' });
    // empty installPath flags "needs reinstall"
    expect(state.apps['com.samsung.vdx.a']?.installPath).toBe('');
    // settings replaced
    expect(state.settings.language).toBe('ko');
    expect(state.settings.updateChannel).toBe('beta');
  });

  it('does NOT clobber an already-installed entry path/manifest', async () => {
    const store = makeStore();
    await store.update((s) => {
      s.apps['com.samsung.vdx.a'] = {
        version: '1.0.0',
        installScope: 'user',
        installPath: '/real/path',
        wizardAnswers: { foo: 'old' },
        journal: [],
        manifestSnapshot: fakeManifest,
        installedAt: '2026-04-01T00:00:00.000Z',
        updateChannel: 'stable',
        autoUpdate: 'ask',
        source: 'catalog',
        kind: 'app',
      };
    });
    await handleHostImportState(
      { installedStore: store, hostVersion: '0.1.0', placeholderManifestForId: placeholder },
      {
        backup: {
          backupSchema: 1,
          exportedAt: '2026-05-01T00:00:00.000Z',
          hostVersion: '0.1.0',
          apps: {
            'com.samsung.vdx.a': {
              version: '2.0.0',
              installScope: 'user',
              wizardAnswers: { foo: 'new' },
              kind: 'app',
              updateChannel: 'beta',
              autoUpdate: 'auto',
            },
          },
          settings: {
            language: 'en',
            updateChannel: 'stable',
            autoUpdateHost: 'ask',
            autoUpdateApps: 'ask',
            cacheLimitGb: 5,
            proxy: null,
            telemetry: false,
            trayMode: false,
            developerMode: false,
          },
        },
        reinstall: false,
      },
    );
    const state = await store.read();
    // installPath preserved (we don't fabricate a path for an existing real install)
    expect(state.apps['com.samsung.vdx.a']?.installPath).toBe('/real/path');
    // wizardAnswers replaced (the operator's intent)
    expect(state.apps['com.samsung.vdx.a']?.wizardAnswers).toEqual({ foo: 'new' });
    expect(state.apps['com.samsung.vdx.a']?.autoUpdate).toBe('auto');
  });

  it('rejects malformed payloads', async () => {
    const store = makeStore();
    const r = await handleHostImportState(
      { installedStore: store, hostVersion: '0.1.0', placeholderManifestForId: placeholder },
      { backup: { wrong: 'shape' }, reinstall: false } as never,
    );
    expect(r.ok).toBe(false);
  });
});
