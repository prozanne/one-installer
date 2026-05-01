import { describe, it, expect } from 'vitest';
import { runInstall } from '@main/engine/install';
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
    {
      type: 'registry',
      hive: 'HKCU',
      key: 'Software\\Samsung\\X',
      values: { InstallPath: { type: 'REG_SZ', data: '{{installPath}}' } },
    },
  ],
  uninstall: { removePaths: ['{{installPath}}'], removeShortcuts: true, removeEnvPath: true },
});

describe('runInstall', () => {
  it('extracts payload, runs actions, registers ARP, returns committed transaction', async () => {
    const p = new MockPlatform();
    const journal = createJournalStore('/journal', p.fs);
    const runner = createTransactionRunner({ journal });
    const payload = await makeZip({ 'x.exe': 'binary' });

    const result = await runInstall({
      manifest: baseManifest(),
      payloadBytes: payload,
      wizardAnswers: { installPath: 'C:/Users/u/AppData/Local/Programs/Samsung/X' },
      platform: p,
      runner,
      hostExePath: 'C:/host.exe',
      lockDir: '/locks',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.committed.status).toBe('committed');
      expect(p.shortcuts.size).toBe(1);
      expect(await p.registryRead('HKCU', 'Software\\Samsung\\X', 'InstallPath')).toEqual({
        type: 'REG_SZ',
        data: 'C:/Users/u/AppData/Local/Programs/Samsung/X',
      });
      expect(
        await p.registryRead(
          'HKCU',
          'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.samsung.vdx.x',
          'DisplayName',
        ),
      ).toEqual({ type: 'REG_SZ', data: 'X' });
    }
  });

  it('rejects installPath outside the sanctioned prefix', async () => {
    const p = new MockPlatform();
    const journal = createJournalStore('/journal', p.fs);
    const runner = createTransactionRunner({ journal });
    const payload = await makeZip({ 'x.exe': 'binary' });
    const result = await runInstall({
      manifest: baseManifest(),
      payloadBytes: payload,
      wizardAnswers: { installPath: 'C:/Windows/System32' },
      platform: p,
      runner,
      hostExePath: 'C:/host.exe',
      lockDir: '/locks',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/out of scope/i);
  });

  it('reclaims a stale lock from a crashed prior install', async () => {
    // Simulate: prior install process crashed mid-way and left a lockfile
    // behind with its (now-dead) PID. A new install must recover, not refuse.
    const p = new MockPlatform({ livePids: [process.pid] }); // 9999 is dead
    await p.ensureDir('/locks');
    await p.fs.promises.writeFile(
      '/locks/com.samsung.vdx.x.lock',
      'pid=9999\nat=2026-01-01T00:00:00.000Z\n',
    );
    const journal = createJournalStore('/journal', p.fs);
    const runner = createTransactionRunner({ journal });
    const payload = await makeZip({ 'x.exe': 'b' });

    const result = await runInstall({
      manifest: baseManifest(),
      payloadBytes: payload,
      wizardAnswers: { installPath: 'C:/Users/u/AppData/Local/Programs/Samsung/X' },
      platform: p,
      runner,
      hostExePath: 'C:/host.exe',
      lockDir: '/locks',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects UNC installPath', async () => {
    const p = new MockPlatform();
    const journal = createJournalStore('/journal', p.fs);
    const runner = createTransactionRunner({ journal });
    const payload = await makeZip({ 'x.exe': 'b' });
    const result = await runInstall({
      manifest: baseManifest(),
      payloadBytes: payload,
      wizardAnswers: { installPath: '//attacker.example/share/drop' },
      platform: p,
      runner,
      hostExePath: 'C:/host.exe',
      lockDir: '/locks',
    });
    expect(result.ok).toBe(false);
  });

  it('rolls back when an action fails', async () => {
    const p = new MockPlatform();
    const journal = createJournalStore('/journal', p.fs);
    const runner = createTransactionRunner({ journal });
    const payload = await makeZip({ 'x.exe': 'binary' });

    const desktopDir = p.systemVars().Desktop!;
    await p.ensureDir(desktopDir);
    await p.createShortcut({
      path: `${desktopDir}/X.lnk`,
      target: '/preexisting.exe',
    });

    const result = await runInstall({
      manifest: baseManifest(),
      payloadBytes: payload,
      wizardAnswers: { installPath: 'C:/Users/u/AppData/Local/Programs/Samsung/X' },
      platform: p,
      runner,
      hostExePath: 'C:/host.exe',
      lockDir: '/locks',
    });

    expect(result.ok).toBe(false);
    expect(
      await p.registryRead(
        'HKCU',
        'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.samsung.vdx.x',
        'DisplayName',
      ),
    ).toBeNull();
    expect(p.shortcuts.size).toBe(1);
    expect(p.shortcuts.get(`${desktopDir}/X.lnk`)?.target).toBe('/preexisting.exe');
  });
});
