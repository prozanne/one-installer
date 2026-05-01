import { describe, it, expect } from 'vitest';
import { runInstall } from '@main/engine/install';
import { runUninstall } from '@main/engine/uninstall';
import { MockPlatform } from '@main/platform';
import { createJournalStore } from '@main/state/journal-store';
import { createTransactionRunner } from '@main/engine/transaction';
import { makeZip } from '../helpers/make-zip';
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
  wizard: [{ type: 'summary' }],
  install: { extract: [{ from: '**/*', to: '{{installPath}}' }] },
  postInstall: [
    { type: 'shortcut', where: 'desktop', target: '{{installPath}}/x.exe', name: 'X' },
    { type: 'envPath', scope: 'user', add: '{{installPath}}/bin' },
  ],
  uninstall: { removePaths: ['{{installPath}}'], removeShortcuts: true, removeEnvPath: true },
});

describe('runUninstall', () => {
  it('removes everything install created', async () => {
    const p = new MockPlatform();
    const journal = createJournalStore('/journal', p.fs);
    const runner = createTransactionRunner({ journal });
    const payload = await makeZip({ 'x.exe': 'b', 'bin/lib.dll': 'b' });

    const installRes = await runInstall({
      manifest: baseManifest(),
      payloadBytes: payload,
      wizardAnswers: { installPath: 'C:/Users/u/AppData/Local/Programs/Samsung/X' },
      platform: p,
      runner,
      hostExePath: 'C:/h.exe',
      lockDir: '/locks',
    });
    expect(installRes.ok).toBe(true);
    if (!installRes.ok) return;

    expect(p.shortcuts.size).toBe(1);
    expect(p.userPath).toContain('C:/Users/u/AppData/Local/Programs/Samsung/X/bin');

    const uninstallRes = await runUninstall({
      manifest: baseManifest(),
      installPath: 'C:/Users/u/AppData/Local/Programs/Samsung/X',
      journalEntries: installRes.value.committed.steps,
      platform: p,
      runner,
      scope: 'user',
      lockDir: '/locks',
    });
    expect(uninstallRes.ok).toBe(true);
    expect(p.shortcuts.size).toBe(0);
    expect(p.userPath).not.toContain('C:/Users/u/AppData/Local/Programs/Samsung/X/bin');
    expect(
      await p.registryRead(
        'HKCU',
        'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.samsung.vdx.x',
        'DisplayName',
      ),
    ).toBeNull();
    expect(await p.pathExists('C:/Users/u/AppData/Local/Programs/Samsung/X')).toBe(false);
  });
});
