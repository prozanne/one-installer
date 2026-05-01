/**
 * CLI smoke tests — boot the CLI with a fake host and assert the
 * stdout/stderr + exit-code contract.
 *
 * The host bootstrap is replaced wholesale via `_setCliHostForTest`,
 * which avoids touching the user's real `installed.json` (or
 * accidentally reading the developer's macOS Application Support
 * directory during CI).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Volume, createFsFromVolume } from 'memfs';
import type * as nodeFs from 'node:fs';
import { _setCliHostForTest, _resetCliHostForTest, type CliHost } from '../../src/cli/host-bootstrap';
import { createInstalledStore } from '@main/state/installed-store';
import { createJournalStore } from '@main/state/journal-store';
import { createTransactionRunner } from '@main/engine/transaction';
import { MockPlatform } from '@main/platform';
import type { CatalogT, Manifest } from '@shared/schema';

// memfs returns its own typeof fs but the engine takes node's typeof fs;
// the runtime shape is compatible — only TypeScript's structural narrowing
// disagrees. Aliasing through `unknown` is the cleanest cast.
type FsLike = typeof nodeFs;

const fakeManifest = (id = 'com.samsung.vdx.a'): Manifest =>
  ({
    schemaVersion: 1,
    id,
    name: { default: id },
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

function makeFakeHost(): CliHost {
  const vol = new Volume();
  const fs = createFsFromVolume(vol) as unknown as FsLike;
  const journal = createJournalStore('/journal', fs);
  const installed = createInstalledStore('/installed.json', fs, '0.1.0');
  return {
    paths: {
      userData: '/u',
      installedJson: '/installed.json',
      cacheDir: '/c',
      logsDir: '/l',
      locksDir: '/lk',
      journalDir: '/journal',
      keysDir: '/k',
      authStore: '/a',
    },
    config: {
      schemaVersion: 1,
      source: { type: 'local-fs', localFs: { rootPath: '/local' } },
      channel: 'stable',
      telemetry: false,
      developerMode: false,
    } as never,
    installedStore: installed,
    journalStore: journal,
    runner: createTransactionRunner({ journal }),
    platform: new MockPlatform(),
    packageSource: null,
    trustRoots: [new Uint8Array(32)],
    hostVersion: '0.1.0-dev',
  };
}

let stdout: string;

beforeEach(() => {
  stdout = '';
  // stderr is captured but discarded — status() writes there but tests
  // only assert on stdout. We still mock to keep the test runner output
  // clean.
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  // Force NO_COLOR for predictable string assertions.
  process.env['NO_COLOR'] = '1';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['NO_COLOR'];
  _resetCliHostForTest();
});

describe('vdx CLI', () => {
  it('--help prints usage and exits 0', async () => {
    const { main } = await import('../../src/cli/index');
    const rc = await main(['--help']);
    expect(rc).toBe(0);
    expect(stdout).toContain('vdx');
    expect(stdout).toContain('install');
    expect(stdout).toContain('sync');
    expect(stdout).toContain('export');
  });

  it('--version prints version', async () => {
    const { main } = await import('../../src/cli/index');
    const rc = await main(['--version']);
    expect(rc).toBe(0);
    expect(stdout).toMatch(/vdx \d+\.\d+\.\d+/);
  });

  it('list --installed shows nothing on a fresh host', async () => {
    _setCliHostForTest(makeFakeHost());
    const { main } = await import('../../src/cli/index');
    const rc = await main(['list', '--installed']);
    expect(rc).toBe(0);
    expect(stdout).toMatch(/No apps installed/);
  });

  it('list --installed shows installed entries', async () => {
    const host = makeFakeHost();
    await host.installedStore.update((s) => {
      s.apps['com.samsung.vdx.x'] = {
        version: '1.2.3',
        installScope: 'user',
        installPath: '/i/x',
        wizardAnswers: {},
        journal: [],
        manifestSnapshot: fakeManifest('com.samsung.vdx.x'),
        installedAt: '2026-04-01T00:00:00.000Z',
        updateChannel: 'stable',
        autoUpdate: 'ask',
        source: 'catalog',
        kind: 'app',
      };
    });
    _setCliHostForTest(host);
    const { main } = await import('../../src/cli/index');
    const rc = await main(['list', '--installed']);
    expect(rc).toBe(0);
    expect(stdout).toContain('x');
    expect(stdout).toContain('1.2.3');
  });

  it('info reports installed details', async () => {
    const host = makeFakeHost();
    await host.installedStore.update((s) => {
      s.apps['com.samsung.vdx.y'] = {
        version: '2.0.0',
        installScope: 'user',
        installPath: '/i/y',
        wizardAnswers: {},
        journal: [],
        manifestSnapshot: fakeManifest('com.samsung.vdx.y'),
        installedAt: '2026-04-01T00:00:00.000Z',
        updateChannel: 'beta',
        autoUpdate: 'auto',
        source: 'catalog',
        kind: 'app',
      };
    });
    _setCliHostForTest(host);
    const { main } = await import('../../src/cli/index');
    const rc = await main(['info', 'com.samsung.vdx.y']);
    expect(rc).toBe(0);
    expect(stdout).toContain('com.samsung.vdx.y');
    expect(stdout).toContain('2.0.0');
    expect(stdout).toContain('beta');
  });

  it('info on unknown id returns error', async () => {
    _setCliHostForTest(makeFakeHost());
    const { main } = await import('../../src/cli/index');
    const rc = await main(['info', 'unknown']);
    expect(rc).toBe(1);
  });

  it('export emits valid JSON to stdout', async () => {
    const host = makeFakeHost();
    await host.installedStore.update((s) => {
      s.apps['com.samsung.vdx.z'] = {
        version: '1.0.0',
        installScope: 'user',
        installPath: '/i/z',
        wizardAnswers: { foo: 'bar' },
        journal: [],
        manifestSnapshot: fakeManifest('com.samsung.vdx.z'),
        installedAt: '2026-04-01T00:00:00.000Z',
        updateChannel: 'stable',
        autoUpdate: 'ask',
        source: 'catalog',
        kind: 'app',
      };
    });
    _setCliHostForTest(host);
    const { main } = await import('../../src/cli/index');
    const rc = await main(['export']);
    expect(rc).toBe(0);
    const lines = stdout.trim().split('\n');
    const json = JSON.parse(lines.join('\n')) as { apps: Record<string, unknown> };
    expect(json.apps['com.samsung.vdx.z']).toBeDefined();
  });

  it('unknown command prints error and help', async () => {
    _setCliHostForTest(makeFakeHost());
    const { main } = await import('../../src/cli/index');
    const rc = await main(['definitely-not-a-command']);
    expect(rc).toBe(1);
    expect(stdout).toContain('Unknown command');
  });

  it('search refuses without a catalog source', async () => {
    _setCliHostForTest(makeFakeHost());
    const { main } = await import('../../src/cli/index');
    const rc = await main(['search', 'foo']);
    expect(rc).toBe(1);
    expect(stdout).toContain('No catalog source');
  });

  it('install with empty args prints usage', async () => {
    _setCliHostForTest(makeFakeHost());
    const { main } = await import('../../src/cli/index');
    const rc = await main(['install']);
    expect(rc).toBe(1);
    expect(stdout).toContain('Usage');
  });

  it('sync without syncProfile config returns 1', async () => {
    _setCliHostForTest(makeFakeHost());
    const { main } = await import('../../src/cli/index');
    const rc = await main(['sync']);
    expect(rc).toBe(1);
    expect(stdout).toContain('No syncProfile');
  });

  // The CatalogT type is unused but kept here to make it available to future
  // tests that fake a packageSource.
  void ({} as CatalogT);
});
