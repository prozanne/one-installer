import { describe, it, expect } from 'vitest';
import { validateManifestSemantics } from '@main/engine/validate';
import type { Manifest } from '@shared/schema';

const baseManifest = (): Manifest => ({
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
  wizard: [
    { type: 'path', id: 'installPath', label: { default: 'P' }, default: '{ProgramFiles}/X' },
    { type: 'summary' },
  ],
  install: { extract: [{ from: '**/*', to: '{{installPath}}' }] },
  postInstall: [],
  uninstall: { removePaths: ['{{installPath}}'], removeShortcuts: true, removeEnvPath: true },
});

describe('validateManifestSemantics', () => {
  it('passes minimal valid manifest', () => {
    const r = validateManifestSemantics(baseManifest(), {
      payloadEntries: ['a.txt', 'core/b.dll'],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects extract from path missing in payload', () => {
    const m = baseManifest();
    m.install.extract = [{ from: 'missing/**', to: '{{installPath}}' }];
    const r = validateManifestSemantics(m, { payloadEntries: ['core/x.dll'] });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown template variable', () => {
    const m = baseManifest();
    m.install.extract = [{ from: '**/*', to: '{{nonexistent}}' }];
    const r = validateManifestSemantics(m, { payloadEntries: ['x.dll'] });
    expect(r.ok).toBe(false);
  });

  it('rejects exec cmd outside installPath/payloadDir', () => {
    const m = baseManifest();
    m.postInstall = [
      {
        type: 'exec',
        cmd: 'C:/Windows/System32/calc.exe',
        args: [],
        timeoutSec: 5,
        allowedHashes: ['sha256:' + 'b'.repeat(64)],
      },
    ];
    const r = validateManifestSemantics(m, { payloadEntries: ['x.dll'] });
    expect(r.ok).toBe(false);
  });

  it('rejects bad when expression', () => {
    const m = baseManifest();
    m.postInstall = [
      { type: 'envPath', scope: 'user', add: '{{installPath}}/bin', when: 'process.exit()' },
    ];
    const r = validateManifestSemantics(m, { payloadEntries: ['x.dll'] });
    expect(r.ok).toBe(false);
  });
});
