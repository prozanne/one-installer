import { describe, it, expect } from 'vitest';
import { ManifestSchema, type Manifest } from '@shared/schema/manifest';

const minimal = {
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

describe('ManifestSchema', () => {
  it('accepts a minimal valid manifest', () => {
    const parsed: Manifest = ManifestSchema.parse(minimal);
    expect(parsed.id).toBe('com.samsung.vdx.example');
  });

  it('rejects bad id format', () => {
    expect(() => ManifestSchema.parse({ ...minimal, id: 'BadID' })).toThrow();
  });

  it('rejects bad version', () => {
    expect(() => ManifestSchema.parse({ ...minimal, version: 'v1' })).toThrow();
  });

  it('accepts all wizard step types', () => {
    const m = {
      ...minimal,
      wizard: [
        { type: 'license', id: 'eula', fileFromPayload: 'EULA.txt' },
        { type: 'path', id: 'installPath', label: { default: 'Path' }, default: '{ProgramFiles}/X' },
        {
          type: 'checkboxGroup',
          id: 'comp',
          label: { default: 'Components' },
          items: [{ id: 'core', label: { default: 'Core' }, default: true, required: true }],
        },
        {
          type: 'select',
          id: 'sc',
          label: { default: 'Shortcut' },
          options: [{ value: 'menu', label: { default: 'Menu' }, default: true }],
        },
        { type: 'text', id: 'name', label: { default: 'Name' }, default: '', optional: true },
        { type: 'summary' },
      ],
    };
    expect(() => ManifestSchema.parse(m)).not.toThrow();
  });

  it('accepts all postInstall action types', () => {
    const m = {
      ...minimal,
      postInstall: [
        { type: 'shortcut', where: 'desktop', target: '{{installPath}}/x.exe', name: 'X' },
        {
          type: 'registry',
          hive: 'HKCU',
          key: 'Software\\X',
          values: { K: { type: 'REG_SZ', data: 'v' } },
        },
        { type: 'envPath', scope: 'user', add: '{{installPath}}/bin' },
        {
          type: 'exec',
          cmd: '{{installPath}}/x.exe',
          args: ['--silent'],
          timeoutSec: 30,
          allowedHashes: ['sha256:' + 'b'.repeat(64)],
        },
      ],
    };
    expect(() => ManifestSchema.parse(m)).not.toThrow();
  });

  it('rejects exec without allowedHashes', () => {
    const m = {
      ...minimal,
      postInstall: [
        {
          type: 'exec',
          cmd: '{{installPath}}/x.exe',
          args: [],
          timeoutSec: 30,
          allowedHashes: [],
        },
      ],
    };
    expect(() => ManifestSchema.parse(m)).toThrow();
  });

  it('rejects exec with timeout above max', () => {
    const m = {
      ...minimal,
      postInstall: [
        {
          type: 'exec',
          cmd: 'x',
          args: [],
          timeoutSec: 9999,
          allowedHashes: ['sha256:' + 'b'.repeat(64)],
        },
      ],
    };
    expect(() => ManifestSchema.parse(m)).toThrow();
  });

  it('rejects when last step is not summary', () => {
    const m = {
      ...minimal,
      wizard: [{ type: 'path', id: 'p', label: { default: 'P' }, default: '' }],
    };
    expect(() => ManifestSchema.parse(m)).toThrow();
  });
});
