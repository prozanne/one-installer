/**
 * test/ipc/ipc-schemas.test.ts
 *
 * Zod schema round-trip + rejection tests for all IPC schemas defined in
 * src/shared/ipc-types.ts. No Electron runtime needed — pure schema logic.
 */

import { describe, it, expect } from 'vitest';
import {
  CatalogFetchReq,
  CatalogFetchRes,
  CatalogInstallReq,
  CatalogInstallRes,
  SideloadOpenReq,
  SideloadOpenRes,
  InstallRunReq,
  InstallRunRes,
  UninstallRunReq,
  UninstallRunRes,
  ProgressEvent,
  CatalogKindSchema,
  SettingsGetReq,
  SettingsGetRes,
  SettingsSetReq,
  SettingsSetRes,
  DiagExportReq,
  DiagExportRes,
  DiagOpenLogsReq,
  DiagOpenLogsRes,
  UpdateCheckReq,
  UpdateCheckRes,
  UpdateRunReq,
  UpdateRunRes,
} from '@shared/ipc-types';

// ---------------------------------------------------------------------------
// Helpers — minimal valid fixture objects
// ---------------------------------------------------------------------------

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_DATETIME = '2026-05-01T12:00:00.000Z';
const VALID_URL = 'https://example.invalid/catalog.json';

const minimalManifest = {
  schemaVersion: 1 as const,
  id: 'com.samsung.vdx.example',
  name: { default: 'Example' },
  version: '1.0.0',
  publisher: 'Samsung',
  description: { default: 'desc' },
  payload: { filename: 'payload.zip', sha256: 'a'.repeat(64), compressedSize: 100 },
  size: { download: 100, installed: 200 },
  minHostVersion: '1.0.0',
  targets: { os: 'win32' as const, arch: ['x64' as const] },
  installScope: { supports: ['user' as const], default: 'user' as const },
  requiresReboot: false,
  wizard: [{ type: 'summary' as const }],
  install: { extract: [{ from: '**/*', to: '{{installPath}}' }] },
  postInstall: [],
  uninstall: { removePaths: ['{{installPath}}'], removeShortcuts: true, removeEnvPath: true },
};

const validCatalog = {
  schemaVersion: 1 as const,
  updatedAt: VALID_DATETIME,
  channels: ['stable' as const],
  categories: [],
  featured: [],
  apps: [
    {
      id: 'com.samsung.vdx.example',
      latestVersion: '1.0.0',
      packageUrl: 'https://example.invalid/app.vdxpkg',
      category: 'tools',
      channels: ['stable' as const],
      tags: [],
      minHostVersion: '0.1.0',
      deprecated: false,
      replacedBy: null,
      addedAt: VALID_DATETIME,
    },
  ],
};

// ---------------------------------------------------------------------------
// 1. CatalogKindSchema
// ---------------------------------------------------------------------------
describe('CatalogKindSchema', () => {
  it('accepts "app"', () => {
    expect(CatalogKindSchema.parse('app')).toBe('app');
  });

  it('accepts "agent"', () => {
    expect(CatalogKindSchema.parse('agent')).toBe('agent');
  });

  it('rejects unknown kind', () => {
    expect(() => CatalogKindSchema.parse('plugin')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. CatalogFetchReq
// ---------------------------------------------------------------------------
describe('CatalogFetchReq', () => {
  it('accepts valid kind "app"', () => {
    const result = CatalogFetchReq.parse({ kind: 'app' });
    expect(result.kind).toBe('app');
  });

  it('accepts valid kind "agent"', () => {
    const result = CatalogFetchReq.parse({ kind: 'agent' });
    expect(result.kind).toBe('agent');
  });

  it('rejects missing kind', () => {
    expect(() => CatalogFetchReq.parse({})).toThrow();
  });

  it('rejects unknown kind value', () => {
    expect(() => CatalogFetchReq.parse({ kind: 'widget' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. CatalogFetchRes — discriminated union on ok
// ---------------------------------------------------------------------------
describe('CatalogFetchRes', () => {
  it('accepts ok:true branch with all required fields', () => {
    const result = CatalogFetchRes.parse({
      ok: true,
      catalog: validCatalog,
      signatureValid: true,
      fetchedAt: VALID_DATETIME,
      sourceUrl: VALID_URL,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.signatureValid).toBe(true);
      expect(result.sourceUrl).toBe(VALID_URL);
    }
  });

  it('accepts ok:false branch', () => {
    const result = CatalogFetchRes.parse({
      ok: false,
      error: 'network failure',
      sourceUrl: VALID_URL,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('network failure');
  });

  it('accepts ok:false with null sourceUrl', () => {
    const result = CatalogFetchRes.parse({
      ok: false,
      error: 'unknown',
      sourceUrl: null,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects ok:true missing catalog', () => {
    expect(() =>
      CatalogFetchRes.parse({
        ok: true,
        signatureValid: false,
        fetchedAt: VALID_DATETIME,
        sourceUrl: VALID_URL,
      }),
    ).toThrow();
  });

  it('rejects ok:true with invalid sourceUrl (not a URL)', () => {
    expect(() =>
      CatalogFetchRes.parse({
        ok: true,
        catalog: validCatalog,
        signatureValid: true,
        fetchedAt: VALID_DATETIME,
        sourceUrl: 'not-a-url',
      }),
    ).toThrow();
  });

  it('discriminated union picks ok:false branch on ok=false', () => {
    const parsed = CatalogFetchRes.safeParse({
      ok: false,
      error: 'timeout',
      sourceUrl: null,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. CatalogInstallReq
// ---------------------------------------------------------------------------
describe('CatalogInstallReq', () => {
  it('accepts valid req', () => {
    const result = CatalogInstallReq.parse({ kind: 'app', appId: 'com.samsung.vdx.example' });
    expect(result.appId).toBe('com.samsung.vdx.example');
  });

  it('rejects missing appId', () => {
    expect(() => CatalogInstallReq.parse({ kind: 'app' })).toThrow();
  });

  it('rejects invalid kind', () => {
    expect(() => CatalogInstallReq.parse({ kind: 'bad', appId: 'com.x' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. CatalogInstallRes — discriminated union
// ---------------------------------------------------------------------------
describe('CatalogInstallRes', () => {
  it('accepts ok:true branch', () => {
    const result = CatalogInstallRes.parse({
      ok: true,
      manifest: minimalManifest,
      defaultInstallPath: 'C:\\Programs\\Samsung\\example',
      signatureValid: false,
      sessionId: VALID_UUID,
      kind: 'agent',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.kind).toBe('agent');
  });

  it('accepts ok:false branch', () => {
    const result = CatalogInstallRes.parse({ ok: false, error: 'not found' });
    expect(result.ok).toBe(false);
  });

  it('rejects ok:true missing sessionId', () => {
    expect(() =>
      CatalogInstallRes.parse({
        ok: true,
        manifest: minimalManifest,
        defaultInstallPath: '/tmp',
        signatureValid: true,
        kind: 'app',
        // sessionId missing
      }),
    ).toThrow();
  });

  it('discriminated union picks correct branch on ok=true', () => {
    const parsed = CatalogInstallRes.safeParse({
      ok: true,
      manifest: minimalManifest,
      defaultInstallPath: '/tmp',
      signatureValid: true,
      sessionId: VALID_UUID,
      kind: 'app',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. SideloadOpenReq
// ---------------------------------------------------------------------------
describe('SideloadOpenReq', () => {
  it('accepts a valid vdxpkgPath', () => {
    const result = SideloadOpenReq.parse({ vdxpkgPath: 'C:\\Downloads\\app.vdxpkg' });
    expect(result.vdxpkgPath).toBe('C:\\Downloads\\app.vdxpkg');
  });

  it('rejects missing vdxpkgPath', () => {
    expect(() => SideloadOpenReq.parse({})).toThrow();
  });

  it('rejects non-string vdxpkgPath', () => {
    expect(() => SideloadOpenReq.parse({ vdxpkgPath: 42 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. SideloadOpenRes — discriminated union
// ---------------------------------------------------------------------------
describe('SideloadOpenRes', () => {
  it('accepts ok:true branch', () => {
    const result = SideloadOpenRes.parse({
      ok: true,
      manifest: minimalManifest,
      defaultInstallPath: 'C:\\Programs\\Samsung\\example',
      signatureValid: true,
      sessionId: VALID_UUID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sessionId).toBe(VALID_UUID);
  });

  it('accepts ok:false branch', () => {
    const result = SideloadOpenRes.parse({ ok: false, error: 'not a vdxpkg' });
    expect(result.ok).toBe(false);
  });

  it('rejects ok:true with invalid sessionId (not UUID)', () => {
    expect(() =>
      SideloadOpenRes.parse({
        ok: true,
        manifest: minimalManifest,
        defaultInstallPath: '/tmp',
        signatureValid: false,
        sessionId: 'not-a-uuid',
      }),
    ).toThrow();
  });

  it('discriminated union picks ok:false on ok=false', () => {
    const parsed = SideloadOpenRes.safeParse({ ok: false, error: 'file missing' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. InstallRunReq
// ---------------------------------------------------------------------------
describe('InstallRunReq', () => {
  it('accepts valid req with defaults', () => {
    const result = InstallRunReq.parse({
      sessionId: VALID_UUID,
      wizardAnswers: { installPath: 'C:\\Programs' },
    });
    expect(result.kind).toBe('app'); // default applied
  });

  it('accepts explicit kind "agent"', () => {
    const result = InstallRunReq.parse({
      sessionId: VALID_UUID,
      wizardAnswers: {},
      kind: 'agent',
    });
    expect(result.kind).toBe('agent');
  });

  it('rejects missing sessionId', () => {
    expect(() => InstallRunReq.parse({ wizardAnswers: {} })).toThrow();
  });

  it('rejects sessionId that is not a UUID', () => {
    expect(() =>
      InstallRunReq.parse({ sessionId: 'not-uuid', wizardAnswers: {} }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 9. InstallRunRes — discriminated union
// ---------------------------------------------------------------------------
describe('InstallRunRes', () => {
  it('accepts ok:true with installPath', () => {
    const result = InstallRunRes.parse({ ok: true, installPath: 'C:\\Programs\\Samsung\\Example' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.installPath).toContain('Example');
  });

  it('accepts ok:false with error string', () => {
    const result = InstallRunRes.parse({ ok: false, error: 'extraction failed' });
    expect(result.ok).toBe(false);
  });

  it('rejects ok:true missing installPath', () => {
    expect(() => InstallRunRes.parse({ ok: true })).toThrow();
  });

  it('discriminated union ok=true picks success branch', () => {
    const parsed = InstallRunRes.safeParse({ ok: true, installPath: '/tmp/out' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. UninstallRunReq / UninstallRunRes
// ---------------------------------------------------------------------------
describe('UninstallRunReq', () => {
  it('accepts valid appId', () => {
    const result = UninstallRunReq.parse({ appId: 'com.samsung.vdx.example' });
    expect(result.appId).toBe('com.samsung.vdx.example');
  });

  it('rejects missing appId', () => {
    expect(() => UninstallRunReq.parse({})).toThrow();
  });
});

describe('UninstallRunRes', () => {
  it('accepts ok:true (no extra fields required)', () => {
    const result = UninstallRunRes.parse({ ok: true });
    expect(result.ok).toBe(true);
  });

  it('accepts ok:false with error', () => {
    const result = UninstallRunRes.parse({ ok: false, error: 'app not found' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('app not found');
  });

  it('rejects ok:false without error field', () => {
    expect(() => UninstallRunRes.parse({ ok: false })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 11. ProgressEvent
// ---------------------------------------------------------------------------
describe('ProgressEvent', () => {
  it('accepts all valid phase values', () => {
    const phases = ['extract', 'actions', 'arp', 'commit', 'rollback', 'done', 'error'] as const;
    for (const phase of phases) {
      const result = ProgressEvent.parse({ phase, message: `phase ${phase}` });
      expect(result.phase).toBe(phase);
    }
  });

  it('accepts optional percent in [0, 100]', () => {
    const result = ProgressEvent.parse({ phase: 'extract', message: 'start', percent: 50 });
    expect(result.percent).toBe(50);
  });

  it('rejects percent > 100', () => {
    expect(() =>
      ProgressEvent.parse({ phase: 'extract', message: 'x', percent: 101 }),
    ).toThrow();
  });

  it('rejects percent < 0', () => {
    expect(() =>
      ProgressEvent.parse({ phase: 'extract', message: 'x', percent: -1 }),
    ).toThrow();
  });

  it('rejects unknown phase', () => {
    expect(() =>
      ProgressEvent.parse({ phase: 'unknown', message: 'x' }),
    ).toThrow();
  });

  it('rejects missing message', () => {
    expect(() => ProgressEvent.parse({ phase: 'done' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 12. Settings IPC schemas
// ---------------------------------------------------------------------------

const validSettings = {
  language: 'en',
  updateChannel: 'stable' as const,
  autoUpdateHost: 'auto' as const,
  autoUpdateApps: 'ask' as const,
  cacheLimitGb: 10,
  proxy: null,
  telemetry: true,
  trayMode: false,
  developerMode: false,
};

describe('SettingsGetReq', () => {
  it('accepts empty object (no key filter)', () => {
    const result = SettingsGetReq.parse({});
    expect(result).toEqual({});
  });

  it('accepts valid key name', () => {
    const result = SettingsGetReq.parse({ key: 'language' });
    expect(result.key).toBe('language');
  });

  it('rejects unknown key', () => {
    expect(() => SettingsGetReq.parse({ key: 'notAKey' })).toThrow();
  });
});

describe('SettingsGetRes', () => {
  it('round-trips valid settings in ok:true branch', () => {
    const result = SettingsGetRes.parse({ ok: true, settings: validSettings });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settings.updateChannel).toBe('stable');
      expect(result.settings.cacheLimitGb).toBe(10);
    }
  });

  it('accepts ok:false branch', () => {
    const result = SettingsGetRes.parse({ ok: false, error: 'state not loaded' });
    expect(result.ok).toBe(false);
  });

  it('rejects invalid updateChannel value', () => {
    expect(() =>
      SettingsGetRes.parse({
        ok: true,
        settings: { ...validSettings, updateChannel: 'nightly' },
      }),
    ).toThrow();
  });

  it('rejects ok:true with missing settings', () => {
    expect(() => SettingsGetRes.parse({ ok: true })).toThrow();
  });
});

describe('SettingsSetReq', () => {
  it('accepts partial patch', () => {
    const result = SettingsSetReq.parse({ patch: { language: 'fr' } });
    expect(result.patch.language).toBe('fr');
  });

  it('accepts empty patch', () => {
    const result = SettingsSetReq.parse({ patch: {} });
    expect(result.patch).toEqual({});
  });

  it('rejects invalid autoUpdateHost value', () => {
    expect(() => SettingsSetReq.parse({ patch: { autoUpdateHost: 'always' } })).toThrow();
  });
});

describe('SettingsSetRes', () => {
  it('round-trips ok:true with updated settings', () => {
    const result = SettingsSetRes.parse({ ok: true, settings: validSettings });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.settings.telemetry).toBe(true);
  });

  it('accepts ok:false branch', () => {
    const result = SettingsSetRes.parse({ ok: false, error: 'write failed' });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 13. Diagnostics IPC schemas
// ---------------------------------------------------------------------------

describe('DiagExportReq', () => {
  it('accepts empty object', () => {
    const result = DiagExportReq.parse({});
    expect(result).toEqual({});
  });
});

describe('DiagExportRes', () => {
  it('accepts ok:true (path-free response per Rule 10)', () => {
    const result = DiagExportRes.parse({ ok: true });
    expect(result.ok).toBe(true);
  });

  it('accepts ok:false branch', () => {
    const result = DiagExportRes.parse({ ok: false, error: 'disk full' });
    expect(result.ok).toBe(false);
  });

  it('strips archivePath if a stale caller still sends it', () => {
    // zod object schemas strip unknown keys by default — this is the contract
    // the renderer relies on: even if main is updated mid-rollout to keep
    // returning archivePath, the renderer's parsed object will not contain it.
    const result = DiagExportRes.parse({ ok: true, archivePath: '/tmp/diag.zip' });
    expect(result.ok).toBe(true);
    expect((result as Record<string, unknown>)['archivePath']).toBeUndefined();
  });
});

describe('DiagOpenLogsReq', () => {
  it('accepts empty object (path-free request per Rule 10)', () => {
    const result = DiagOpenLogsReq.parse({});
    expect(result).toEqual({});
  });
});

describe('DiagOpenLogsRes', () => {
  it('accepts ok:true', () => {
    const result = DiagOpenLogsRes.parse({ ok: true });
    expect(result.ok).toBe(true);
  });

  it('accepts ok:false with error', () => {
    const result = DiagOpenLogsRes.parse({ ok: false, error: 'not found' });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 14. Self-update IPC schemas
// ---------------------------------------------------------------------------

const validUpdateInfo = {
  latestVersion: '1.2.0',
  currentVersion: '1.0.0',
  downloadUrl: 'https://example.invalid/installer-1.2.0.exe',
};

describe('UpdateCheckReq', () => {
  it('accepts empty object', () => {
    const result = UpdateCheckReq.parse({});
    expect(result).toEqual({});
  });
});

describe('UpdateCheckRes', () => {
  it('accepts ok:true with null info (up-to-date)', () => {
    const result = UpdateCheckRes.parse({ ok: true, info: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.info).toBeNull();
  });

  it('accepts ok:true with UpdateInfo when newer version available', () => {
    const result = UpdateCheckRes.parse({ ok: true, info: validUpdateInfo });
    expect(result.ok).toBe(true);
    if (result.ok && result.info !== null) {
      expect(result.info.latestVersion).toBe('1.2.0');
      expect(result.info.downloadUrl).toBe('https://example.invalid/installer-1.2.0.exe');
    }
  });

  it('accepts ok:false branch', () => {
    const result = UpdateCheckRes.parse({ ok: false, error: 'network error' });
    expect(result.ok).toBe(false);
  });

  it('rejects UpdateInfo with non-URL downloadUrl', () => {
    expect(() =>
      UpdateCheckRes.parse({
        ok: true,
        info: { ...validUpdateInfo, downloadUrl: 'not-a-url' },
      }),
    ).toThrow();
  });
});

describe('UpdateRunReq', () => {
  it('accepts { confirm: true }', () => {
    const result = UpdateRunReq.parse({ confirm: true });
    expect(result.confirm).toBe(true);
  });

  it('rejects missing confirm', () => {
    expect(() => UpdateRunReq.parse({})).toThrow();
  });

  it('rejects confirm: false (must be literal true)', () => {
    expect(() => UpdateRunReq.parse({ confirm: false })).toThrow();
  });
});

describe('UpdateRunRes', () => {
  it('accepts ok:true', () => {
    const result = UpdateRunRes.parse({ ok: true });
    expect(result.ok).toBe(true);
  });

  it('accepts ok:false with error', () => {
    const result = UpdateRunRes.parse({ ok: false, error: 'download failed' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('download failed');
  });

  it('rejects ok:false without error', () => {
    expect(() => UpdateRunRes.parse({ ok: false })).toThrow();
  });
});
