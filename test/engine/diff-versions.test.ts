import { describe, it, expect } from 'vitest';
import { compareSemver, diffInstalledVsCatalog } from '@main/engine/diff-versions';
import type { InstalledStateT, CatalogItemT, Manifest } from '@shared/schema';

describe('compareSemver', () => {
  it('orders numeric components', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('1.0.1', '1.0.0')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '1.0.1')).toBeLessThan(0);
    expect(compareSemver('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });
  it('treats pre-release as lower than its non-pre counterpart', () => {
    expect(compareSemver('1.0.0', '1.0.0-beta.1')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0-beta.1', '1.0.0-beta.2')).toBeLessThan(0);
  });
});

const fakeManifest = (): Manifest =>
  ({
    schemaVersion: 1,
    id: 'com.samsung.vdx.x',
    name: { default: 'X' },
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

const makeCatalogItem = (overrides: Partial<CatalogItemT> = {}): CatalogItemT => ({
  id: 'com.samsung.vdx.x',
  category: 'apps',
  channels: ['stable'],
  tags: [],
  minHostVersion: '0.1.0',
  deprecated: false,
  replacedBy: null,
  addedAt: '2026-04-01T00:00:00.000Z',
  packageUrl: 'https://example.invalid/x.vdxpkg',
  latestVersion: '1.1.0',
  ...overrides,
});

describe('diffInstalledVsCatalog', () => {
  it('emits a candidate when catalog has a strictly newer version', () => {
    const candidates = diffInstalledVsCatalog({
      installed: makeInstalled(),
      catalogItems: [makeCatalogItem()],
      channel: 'stable',
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      appId: 'com.samsung.vdx.x',
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      policy: 'ask',
      kind: 'app',
    });
  });

  it('skips when catalog version equals installed', () => {
    expect(
      diffInstalledVsCatalog({
        installed: makeInstalled(),
        catalogItems: [makeCatalogItem({ latestVersion: '1.0.0' })],
        channel: 'stable',
      }),
    ).toHaveLength(0);
  });

  it('skips when catalog version is older than installed (downgrade not auto)', () => {
    expect(
      diffInstalledVsCatalog({
        installed: makeInstalled({ version: '2.0.0' }),
        catalogItems: [makeCatalogItem({ latestVersion: '1.0.0' })],
        channel: 'stable',
      }),
    ).toHaveLength(0);
  });

  it('skips items not in the resolved channel', () => {
    expect(
      diffInstalledVsCatalog({
        installed: makeInstalled(),
        catalogItems: [makeCatalogItem({ channels: ['beta'] })],
        channel: 'stable',
      }),
    ).toHaveLength(0);
  });

  it('skips deprecated items', () => {
    expect(
      diffInstalledVsCatalog({
        installed: makeInstalled(),
        catalogItems: [makeCatalogItem({ deprecated: true })],
        channel: 'stable',
      }),
    ).toHaveLength(0);
  });

  it('skips sideloaded apps with no catalog twin', () => {
    expect(
      diffInstalledVsCatalog({
        installed: makeInstalled({ source: 'sideload' }),
        catalogItems: [],
        channel: 'stable',
      }),
    ).toHaveLength(0);
  });

  it('preserves the per-app autoUpdate policy + kind on the candidate', () => {
    const candidates = diffInstalledVsCatalog({
      installed: makeInstalled({ autoUpdate: 'auto', kind: 'agent' }),
      catalogItems: [makeCatalogItem()],
      channel: 'stable',
    });
    expect(candidates[0]?.policy).toBe('auto');
    expect(candidates[0]?.kind).toBe('agent');
  });
});
