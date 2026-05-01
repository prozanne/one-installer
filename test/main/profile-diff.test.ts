import { describe, it, expect } from 'vitest';
import { diffProfile } from '@main/sync/profile-diff';
import type { CatalogT, InstalledStateT, SyncProfileT, Manifest } from '@shared/schema';

const fakeManifest = (): Manifest =>
  ({
    schemaVersion: 1,
    id: 'a',
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
  }) as Manifest;

const installedEntry = (
  appId: string,
  version: string,
  source: 'catalog' | 'sideload' = 'catalog',
  kind: 'app' | 'agent' = 'app',
): InstalledStateT['apps'][string] => ({
  version,
  installScope: 'user',
  installPath: `/i/${appId}`,
  wizardAnswers: {},
  journal: [],
  manifestSnapshot: fakeManifest(),
  installedAt: '2026-04-01T00:00:00.000Z',
  updateChannel: 'stable',
  autoUpdate: 'ask',
  source,
  kind,
});

const profile = (
  apps: SyncProfileT['apps'],
  removeUnlisted = false,
): SyncProfileT => ({
  schemaVersion: 1,
  name: 'P',
  updatedAt: '2026-05-01T00:00:00.000Z',
  apps,
  removeUnlisted,
});

const catalog = (apps: CatalogT['apps']): CatalogT => ({
  schemaVersion: 1,
  updatedAt: '2026-05-01T00:00:00.000Z',
  channels: ['stable'],
  categories: [],
  featured: [],
  apps,
});

// Explicit-undefined-friendly: the second arg defaults to '1.5.0' when
// omitted entirely, but tests can pass `null` to assert the no-version path.
const cat = (id: string, latest: string | null = '1.5.0'): CatalogT['apps'][number] => ({
  id,
  ...(latest ? { latestVersion: latest } : {}),
  packageUrl: 'https://example.invalid/x.vdxpkg',
  category: 'apps',
  channels: ['stable'],
  tags: [],
  minHostVersion: '0.1.0',
  deprecated: false,
  replacedBy: null,
  addedAt: '2026-04-01T00:00:00.000Z',
});

describe('diffProfile', () => {
  it('marks an app in the profile but not installed as missing', () => {
    const drift = diffProfile({
      profile: profile([{ id: 'a', kind: 'app', version: '1.0.0', channel: 'stable', wizardAnswers: {} }]),
      installed: {},
      getCatalog: (k) => (k === 'app' ? catalog([cat('a', '1.0.0')]) : null),
    });
    expect(drift).toHaveLength(1);
    expect(drift[0]?.kind).toBe('missing');
    if (drift[0]?.kind === 'missing') {
      expect(drift[0].unresolvable).toBe(false);
    }
  });

  it('marks unresolvable when catalog has no such id', () => {
    const drift = diffProfile({
      profile: profile([{ id: 'gone', kind: 'app', version: '1.0.0', channel: 'stable', wizardAnswers: {} }]),
      installed: {},
      getCatalog: () => catalog([]),
    });
    expect(drift).toHaveLength(1);
    if (drift[0]?.kind === 'missing') expect(drift[0].unresolvable).toBe(true);
  });

  it('marks an installed-but-older app as outdated', () => {
    const drift = diffProfile({
      profile: profile([{ id: 'a', kind: 'app', version: '2.0.0', channel: 'stable', wizardAnswers: {} }]),
      installed: { a: installedEntry('a', '1.0.0') },
      getCatalog: () => catalog([cat('a', '2.0.0')]),
    });
    expect(drift).toHaveLength(1);
    if (drift[0]?.kind === 'outdated') {
      expect(drift[0].fromVersion).toBe('1.0.0');
      expect(drift[0].toVersion).toBe('2.0.0');
    }
  });

  it('resolves "latest" to catalog.latestVersion', () => {
    const drift = diffProfile({
      profile: profile([{ id: 'a', kind: 'app', version: 'latest', channel: 'stable', wizardAnswers: {} }]),
      installed: { a: installedEntry('a', '1.0.0') },
      getCatalog: () => catalog([cat('a', '3.2.1')]),
    });
    expect(drift).toHaveLength(1);
    if (drift[0]?.kind === 'outdated') expect(drift[0].toVersion).toBe('3.2.1');
  });

  it('skips up-to-date entries', () => {
    const drift = diffProfile({
      profile: profile([{ id: 'a', kind: 'app', version: '1.0.0', channel: 'stable', wizardAnswers: {} }]),
      installed: { a: installedEntry('a', '1.0.0') },
      getCatalog: () => catalog([cat('a', '1.0.0')]),
    });
    expect(drift).toHaveLength(0);
  });

  it('treats kind mismatch as missing (auto-cross-tab not supported)', () => {
    const drift = diffProfile({
      profile: profile([{ id: 'a', kind: 'agent', version: '1.0.0', channel: 'stable', wizardAnswers: {} }]),
      installed: { a: installedEntry('a', '1.0.0', 'catalog', 'app') },
      getCatalog: () => catalog([cat('a', '1.0.0')]),
    });
    expect(drift).toHaveLength(1);
    expect(drift[0]?.kind).toBe('missing');
  });

  it('emits extras only when removeUnlisted=true', () => {
    const installed = { a: installedEntry('a', '1.0.0'), b: installedEntry('b', '1.0.0') };
    const noRemoval = diffProfile({
      profile: profile([{ id: 'a', kind: 'app', version: '1.0.0', channel: 'stable', wizardAnswers: {} }]),
      installed,
      getCatalog: () => catalog([cat('a', '1.0.0')]),
    });
    expect(noRemoval).toHaveLength(0);

    const withRemoval = diffProfile({
      profile: profile([{ id: 'a', kind: 'app', version: '1.0.0', channel: 'stable', wizardAnswers: {} }], true),
      installed,
      getCatalog: () => catalog([cat('a', '1.0.0')]),
    });
    expect(withRemoval).toHaveLength(1);
    if (withRemoval[0]?.kind === 'extra') expect(withRemoval[0].appId).toBe('b');
  });

  it('never lists sideloaded apps as extras', () => {
    const installed = {
      a: installedEntry('a', '1.0.0'),
      sl: installedEntry('sl', '1.0.0', 'sideload'),
    };
    const drift = diffProfile({
      profile: profile([{ id: 'a', kind: 'app', version: '1.0.0', channel: 'stable', wizardAnswers: {} }], true),
      installed,
      getCatalog: () => catalog([cat('a', '1.0.0')]),
    });
    // 'sl' must NOT appear as extra even though removeUnlisted=true.
    expect(drift.find((d) => d.kind === 'extra' && d.appId === 'sl')).toBeUndefined();
  });

  it('yields no outdated when "latest" is requested but catalog has no latestVersion', () => {
    const drift = diffProfile({
      profile: profile([{ id: 'a', kind: 'app', version: 'latest', channel: 'stable', wizardAnswers: {} }]),
      installed: { a: installedEntry('a', '0.1.0') },
      // explicit null sentinel → cat() helper omits latestVersion entirely
      getCatalog: () => catalog([cat('a', null)]),
    });
    expect(drift).toHaveLength(0);
  });
});
