/**
 * test/config/load-config.test.ts
 *
 * Tests for loadVdxConfig — config loader with search-order precedence,
 * singleton guard, schema validation, and redaction.
 */
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadVdxConfig,
  _resetLoadedForTest,
  redactConfigForLogs,
  ConfigError,
} from '@main/config/load-config';

const LOCAL_FS_CONFIG_JSON = JSON.stringify({
  schemaVersion: 1,
  source: { type: 'local-fs', localFs: { rootPath: '/var/vdx-mirror' } },
});

const GITHUB_CONFIG_JSON = JSON.stringify({
  schemaVersion: 1,
  source: {
    type: 'github',
    github: {
      catalogRepo: 'acme/catalog',
      selfUpdateRepo: 'acme/installer',
      appsOrg: 'acme',
      apiBase: 'https://api.github.com',
      ref: 'stable',
    },
  },
});

function makeFsStub(files: Record<string, string>): {
  readFile(p: string, enc: 'utf-8'): Promise<string>;
  access(p: string): Promise<void>;
} {
  return {
    readFile(p: string) {
      if (p in files) return Promise.resolve(files[p]!);
      const err = Object.assign(new Error(`ENOENT: no such file: ${p}`), { code: 'ENOENT' });
      return Promise.reject(err);
    },
    access(p: string) {
      if (p in files) return Promise.resolve();
      const err = Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return Promise.reject(err);
    },
  };
}

beforeEach(() => {
  _resetLoadedForTest();
});

// ---------------------------------------------------------------------------
// 1. Precedence
// ---------------------------------------------------------------------------
describe('loadVdxConfig — search order', () => {
  it('uses next-to-EXE config when present', async () => {
    const exeDir = '/opt/vdx';
    const exeConfig = path.join(exeDir, 'vdx.config.json');
    const fs = makeFsStub({ [exeConfig]: LOCAL_FS_CONFIG_JSON });
    const result = await loadVdxConfig({ exeDir, appDataDir: '/home/user/AppData/Roaming', fs });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.source.type).toBe('local-fs');
    }
  });

  it('falls back to APPDATA config when EXE-adjacent absent', async () => {
    const appDataDir = os.homedir();
    const appDataConfig = path.join(appDataDir, 'vdx-installer', 'vdx.config.json');
    const fs = makeFsStub({ [appDataConfig]: GITHUB_CONFIG_JSON });
    const result = await loadVdxConfig({ exeDir: '/opt/vdx', appDataDir, fs });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.source.type).toBe('github');
    }
  });

  it('uses BUILTIN_DEFAULT_CONFIG when no config file found', async () => {
    const fs = makeFsStub({});
    const result = await loadVdxConfig({
      exeDir: '/opt/vdx',
      appDataDir: os.homedir(),
      fs,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Default is github
      expect(result.value.source.type).toBe('github');
    }
  });

  it('EXE-adjacent config takes precedence over APPDATA config', async () => {
    const exeDir = '/opt/vdx';
    const appDataDir = os.homedir();
    const exeConfig = path.join(exeDir, 'vdx.config.json');
    const appDataConfig = path.join(appDataDir, 'vdx-installer', 'vdx.config.json');
    const fs = makeFsStub({
      [exeConfig]: LOCAL_FS_CONFIG_JSON,
      [appDataConfig]: GITHUB_CONFIG_JSON,
    });
    const result = await loadVdxConfig({ exeDir, appDataDir, fs });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // EXE-adjacent (local-fs) wins over APPDATA (github)
      expect(result.value.source.type).toBe('local-fs');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Schema validation failures
// ---------------------------------------------------------------------------
describe('loadVdxConfig — schema validation (fail-loud)', () => {
  it('returns ConfigError for schema-invalid file (NOT silent fallback)', async () => {
    const exeDir = '/opt/vdx';
    const exeConfig = path.join(exeDir, 'vdx.config.json');
    const fs = makeFsStub({
      [exeConfig]: JSON.stringify({ schemaVersion: 1, source: { type: 'invalid' } }),
    });
    const result = await loadVdxConfig({ exeDir, appDataDir: os.homedir(), fs });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ConfigError);
      expect(result.error.message).toContain('Invalid');
    }
  });

  it('returns ConfigError for malformed JSON file (NOT silent fallback)', async () => {
    const exeDir = '/opt/vdx';
    const exeConfig = path.join(exeDir, 'vdx.config.json');
    const fs = makeFsStub({
      [exeConfig]: '{ broken json ,,, ',
    });
    const result = await loadVdxConfig({ exeDir, appDataDir: os.homedir(), fs });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ConfigError);
    }
  });

  it('returns ConfigError when schemaVersion is 2 (unsupported)', async () => {
    const exeDir = '/opt/vdx';
    const exeConfig = path.join(exeDir, 'vdx.config.json');
    const config = {
      schemaVersion: 2,
      source: { type: 'local-fs', localFs: { rootPath: '/var/vdx' } },
    };
    const fs = makeFsStub({ [exeConfig]: JSON.stringify(config) });
    const result = await loadVdxConfig({ exeDir, appDataDir: os.homedir(), fs });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ConfigError);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Singleton guard
// ---------------------------------------------------------------------------
describe('loadVdxConfig — singleton guard', () => {
  it('throws Error if called twice without reset', async () => {
    const exeDir = '/opt/vdx';
    const exeConfig = path.join(exeDir, 'vdx.config.json');
    const fs = makeFsStub({ [exeConfig]: LOCAL_FS_CONFIG_JSON });

    await loadVdxConfig({ exeDir, appDataDir: os.homedir(), fs });

    // Second call must throw
    await expect(
      loadVdxConfig({ exeDir, appDataDir: os.homedir(), fs }),
    ).rejects.toThrow(/more than once/i);
  });

  it('is idempotent after _resetLoadedForTest (test helper)', async () => {
    const exeDir = '/opt/vdx';
    const exeConfig = path.join(exeDir, 'vdx.config.json');
    const fs = makeFsStub({ [exeConfig]: LOCAL_FS_CONFIG_JSON });

    const first = await loadVdxConfig({ exeDir, appDataDir: os.homedir(), fs });
    _resetLoadedForTest();
    const second = await loadVdxConfig({ exeDir, appDataDir: os.homedir(), fs });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. redactConfigForLogs
// ---------------------------------------------------------------------------
describe('redactConfigForLogs', () => {
  it('strips httpMirror token', async () => {
    const { VdxConfigSchema } = await import('@shared/config/vdx-config');
    const config = VdxConfigSchema.parse({
      schemaVersion: 1,
      source: {
        type: 'http-mirror',
        httpMirror: {
          baseUrl: 'https://mirror.example.com',
          token: 'super-secret-token',
        },
      },
    });
    const redacted = redactConfigForLogs(config);
    const src = redacted.source as Record<string, unknown>;
    const mirror = src['httpMirror'] as Record<string, unknown>;
    expect(mirror['token']).toBe('[REDACTED:TOKEN]');
    expect(mirror['token']).not.toContain('super-secret-token');
  });

  it('strips httpMirror proxyUrl credentials', async () => {
    const { VdxConfigSchema } = await import('@shared/config/vdx-config');
    const config = VdxConfigSchema.parse({
      schemaVersion: 1,
      source: {
        type: 'http-mirror',
        httpMirror: {
          baseUrl: 'https://mirror.example.com',
          proxyUrl: 'http://user:pass@proxy.example.com:8080',
        },
      },
    });
    const redacted = redactConfigForLogs(config);
    const src = redacted.source as Record<string, unknown>;
    const mirror = src['httpMirror'] as Record<string, unknown>;
    expect(mirror['proxyUrl']).not.toContain('user:pass');
  });

  it('abbreviates trustRoots to first 8 chars + ...', async () => {
    const { VdxConfigSchema } = await import('@shared/config/vdx-config');
    const pubkey = Buffer.alloc(32, 0x01).toString('base64');
    const config = VdxConfigSchema.parse({
      schemaVersion: 1,
      source: { type: 'local-fs', localFs: { rootPath: '/var/vdx' } },
      trustRoots: [pubkey],
    });
    const redacted = redactConfigForLogs(config);
    const roots = redacted.trustRoots as string[];
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatch(/^.{8}\.\.\./);
    expect(roots[0]).not.toBe(pubkey);
  });

  it('replaces home directory prefix with ~ in localFs rootPath', async () => {
    const { VdxConfigSchema } = await import('@shared/config/vdx-config');
    const homeRelativePath = os.homedir() + '/vdx-mirror';
    const config = VdxConfigSchema.parse({
      schemaVersion: 1,
      source: { type: 'local-fs', localFs: { rootPath: homeRelativePath } },
    });
    const redacted = redactConfigForLogs(config);
    const src = redacted.source as Record<string, unknown>;
    const localFs = src['localFs'] as Record<string, unknown>;
    expect(localFs['rootPath']).toMatch(/^~/);
    expect(localFs['rootPath']).not.toContain(os.homedir());
  });
});
