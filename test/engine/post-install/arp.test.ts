import { describe, it, expect } from 'vitest';
import { arpRegister, arpDeregister } from '@main/engine/post-install/arp';
import { MockPlatform } from '@main/platform';
import type { Manifest } from '@shared/schema';

const m: Manifest = {
  schemaVersion: 1,
  id: 'com.samsung.vdx.x',
  name: { default: 'X' },
  version: '1.2.3',
  publisher: 'Samsung',
  description: { default: 'd' },
  size: { download: 1, installed: 1024 * 1024 },
  payload: { filename: 'p.zip', sha256: 'a'.repeat(64), compressedSize: 1 },
  minHostVersion: '1.0.0',
  targets: { os: 'win32', arch: ['x64'] },
  installScope: { supports: ['user'], default: 'user' },
  requiresReboot: false,
  wizard: [{ type: 'summary' }],
  install: { extract: [{ from: '**/*', to: '{{installPath}}' }] },
  postInstall: [],
  uninstall: { removePaths: [], removeShortcuts: true, removeEnvPath: true },
};

describe('arp register/deregister', () => {
  it('round-trips', async () => {
    const p = new MockPlatform();
    const entry = await arpRegister({
      platform: p,
      manifest: m,
      installPath: '/Apps/X',
      scope: 'user',
      hostExePath: 'C:/host.exe',
    });
    expect(entry.type).toBe('arp');
    expect(
      (
        await p.registryRead(
          'HKCU',
          'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.samsung.vdx.x',
          'DisplayName',
        )
      )?.data,
    ).toBe('X');
    await arpDeregister(entry, p);
    expect(
      await p.registryRead(
        'HKCU',
        'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.samsung.vdx.x',
        'DisplayName',
      ),
    ).toBeNull();
  });
});
