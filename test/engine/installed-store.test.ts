import { describe, it, expect } from 'vitest';
import { createInstalledStore } from '@main/state/installed-store';
import { ManifestSchema, type Manifest } from '@shared/schema';
import { MockPlatform } from '@main/platform';

const HOST_VER = '0.1.0';

const makeManifest = (): Manifest =>
  ManifestSchema.parse({
    schemaVersion: 1,
    id: 'com.samsung.vdx.x',
    name: { default: 'X' },
    version: '1.0.0',
    publisher: 'Samsung',
    description: { default: 'd' },
    size: { download: 1, installed: 1 },
    payload: { filename: 'p.zip', sha256: 'a'.repeat(64), compressedSize: 1 },
    minHostVersion: '1.0.0',
    targets: { os: 'win32', arch: ['x64'] },
    installScope: { supports: ['user'], default: 'user' },
    requiresReboot: false,
    wizard: [{ type: 'summary' }],
    install: { extract: [{ from: '**/*', to: '{{installPath}}' }] },
    postInstall: [],
    uninstall: { removePaths: [], removeShortcuts: true, removeEnvPath: true },
  });

describe('installed-store', () => {
  it('initializes default state when file missing', async () => {
    const p = new MockPlatform();
    await p.ensureDir('/state');
    const store = createInstalledStore('/state/installed.json', p.fs, HOST_VER);
    const s = await store.read();
    expect(s.schema).toBe(1);
    expect(s.host.version).toBe(HOST_VER);
    expect(s.apps).toEqual({});
  });

  it('persists app installation and read returns it', async () => {
    const p = new MockPlatform();
    await p.ensureDir('/state');
    const store = createInstalledStore('/state/installed.json', p.fs, HOST_VER);
    await store.update((s) => {
      s.apps['com.samsung.vdx.x'] = {
        version: '1.0.0',
        installScope: 'user',
        installPath: '/Apps/X',
        wizardAnswers: { installPath: '/Apps/X' },
        journal: [],
        manifestSnapshot: makeManifest(),
        installedAt: new Date().toISOString(),
        updateChannel: 'stable',
        autoUpdate: 'ask',
        source: 'sideload',
      };
    });
    const s2 = await store.read();
    expect(Object.keys(s2.apps)).toEqual(['com.samsung.vdx.x']);
    expect(s2.apps['com.samsung.vdx.x']?.installPath).toBe('/Apps/X');
  });
});
