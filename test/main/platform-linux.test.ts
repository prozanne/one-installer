/**
 * LinuxPlatform tests. All of them run on macOS / Linux without privilege
 * via a tmpdir-rooted home; the HKLM (root) branch is exercised only via
 * its elevation-gate (rejection path), since real /etc writes need root.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinuxPlatform } from '@main/platform/linux';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'vdx-linux-'));
});
afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('LinuxPlatform — registry shim (HKCU)', () => {
  it('write+read round-trips a value', async () => {
    const p = new LinuxPlatform({ home });
    await p.registryWrite('HKCU', 'Software\\Samsung\\X', 'InstallPath', {
      type: 'REG_SZ',
      data: '/opt/X',
    });
    const v = await p.registryRead('HKCU', 'Software\\Samsung\\X', 'InstallPath');
    expect(v).toEqual({ type: 'REG_SZ', data: '/opt/X' });
  });

  it('keyExists reflects file presence', async () => {
    const p = new LinuxPlatform({ home });
    expect(await p.registryKeyExists('HKCU', 'Software\\Samsung\\X')).toBe(false);
    await p.registryWrite('HKCU', 'Software\\Samsung\\X', 'V', { type: 'REG_SZ', data: 'a' });
    expect(await p.registryKeyExists('HKCU', 'Software\\Samsung\\X')).toBe(true);
  });

  it('deleteValue leaves the key file when other values remain', async () => {
    const p = new LinuxPlatform({ home });
    await p.registryWrite('HKCU', 'Software\\X', 'A', { type: 'REG_SZ', data: '1' });
    await p.registryWrite('HKCU', 'Software\\X', 'B', { type: 'REG_SZ', data: '2' });
    await p.registryDeleteValue('HKCU', 'Software\\X', 'A');
    expect(await p.registryRead('HKCU', 'Software\\X', 'A')).toBeNull();
    expect((await p.registryRead('HKCU', 'Software\\X', 'B'))?.data).toBe('2');
  });

  it('deleteValue removes the key file when no values remain', async () => {
    const p = new LinuxPlatform({ home });
    await p.registryWrite('HKCU', 'Software\\X', 'A', { type: 'REG_SZ', data: '1' });
    await p.registryDeleteValue('HKCU', 'Software\\X', 'A');
    expect(await p.registryKeyExists('HKCU', 'Software\\X')).toBe(false);
  });

  it('deleteKey is idempotent on absent keys', async () => {
    const p = new LinuxPlatform({ home });
    await expect(p.registryDeleteKey('HKCU', 'Software\\Missing', false)).resolves.toBeUndefined();
  });

  it('rejects HKLM writes without elevationGranted', async () => {
    const p = new LinuxPlatform({ home });
    await expect(
      p.registryWrite('HKLM', 'Software\\X', 'V', { type: 'REG_SZ', data: '1' }),
    ).rejects.toThrow(/elevation/i);
  });

  it('normalises mixed separators in key paths', async () => {
    const p = new LinuxPlatform({ home });
    await p.registryWrite('HKCU', 'A\\B/C', 'V', { type: 'REG_SZ', data: '1' });
    expect((await p.registryRead('HKCU', 'A/B\\C', 'V'))?.data).toBe('1');
  });
});

describe('LinuxPlatform — shortcuts (.desktop)', () => {
  it('creates a .desktop file at the given path', async () => {
    const p = new LinuxPlatform({ home });
    const path = join(home, '.local/share/applications/MyApp.desktop');
    await p.createShortcut({
      path,
      target: '/opt/MyApp/run',
      description: 'My App',
      args: '--launch',
      workingDir: '/opt/MyApp',
    });
    const body = readFileSync(path, 'utf-8');
    expect(body).toMatch(/^\[Desktop Entry\]/);
    expect(body).toMatch(/Name=My App/);
    expect(body).toMatch(/Exec=\/opt\/MyApp\/run --launch/);
    expect(body).toMatch(/Path=\/opt\/MyApp/);
  });

  it('rewrites .lnk paths to .desktop on Linux', async () => {
    const p = new LinuxPlatform({ home });
    const lnk = join(home, 'Desktop/X.lnk');
    await p.createShortcut({
      path: lnk,
      target: '/opt/x',
      description: 'X',
    });
    // The actual file lives at .desktop; the .lnk path is gone.
    expect(existsSync(lnk)).toBe(false);
    expect(existsSync(lnk.replace(/\.lnk$/, '.desktop'))).toBe(true);
    await p.deleteShortcut(lnk);
    expect(existsSync(lnk.replace(/\.lnk$/, '.desktop'))).toBe(false);
  });

  it('quotes paths with spaces in Exec=', async () => {
    const p = new LinuxPlatform({ home });
    const path = join(home, 'spacey.desktop');
    await p.createShortcut({
      path,
      target: '/opt/My App/run binary',
      description: 'spacey',
    });
    const body = readFileSync(path, 'utf-8');
    expect(body).toMatch(/Exec="\/opt\/My App\/run binary"/);
  });

  it('deleteShortcut on missing file is idempotent', async () => {
    const p = new LinuxPlatform({ home });
    await expect(p.deleteShortcut(join(home, 'nope.desktop'))).resolves.toBeUndefined();
  });
});

describe('LinuxPlatform — env PATH (~/.profile marker block)', () => {
  it('adds an entry inside a managed marker block', async () => {
    const p = new LinuxPlatform({ home });
    await p.pathEnvAdd('user', '/opt/Samsung/X/bin');
    const profile = readFileSync(join(home, '.profile'), 'utf-8');
    expect(profile).toMatch(/# >>> vdx-installer managed PATH/);
    expect(profile).toMatch(/export PATH="\/opt\/Samsung\/X\/bin:\$PATH"/);
    expect(profile).toMatch(/# <<< vdx-installer managed PATH/);
  });

  it('add is idempotent', async () => {
    const p = new LinuxPlatform({ home });
    await p.pathEnvAdd('user', '/opt/X/bin');
    await p.pathEnvAdd('user', '/opt/X/bin');
    const profile = readFileSync(join(home, '.profile'), 'utf-8');
    const occurrences = profile.match(/export PATH="\/opt\/X\/bin:/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it('preserves existing user profile content above the block', async () => {
    writeFileSync(join(home, '.profile'), '# user content\nexport FOO=bar\n');
    const p = new LinuxPlatform({ home });
    await p.pathEnvAdd('user', '/opt/X/bin');
    const profile = readFileSync(join(home, '.profile'), 'utf-8');
    expect(profile.startsWith('# user content\nexport FOO=bar')).toBe(true);
    expect(profile).toMatch(/export PATH="\/opt\/X\/bin:/);
  });

  it('removes a single entry but keeps the block when others remain', async () => {
    const p = new LinuxPlatform({ home });
    await p.pathEnvAdd('user', '/opt/A/bin');
    await p.pathEnvAdd('user', '/opt/B/bin');
    await p.pathEnvRemove('user', '/opt/A/bin');
    const profile = readFileSync(join(home, '.profile'), 'utf-8');
    expect(profile).not.toMatch(/\/opt\/A\/bin/);
    expect(profile).toMatch(/\/opt\/B\/bin/);
    expect(profile).toMatch(/# >>> vdx-installer managed PATH/);
  });

  it('removes the marker block entirely when last entry is removed', async () => {
    writeFileSync(join(home, '.profile'), '# user content\n');
    const p = new LinuxPlatform({ home });
    await p.pathEnvAdd('user', '/opt/A/bin');
    await p.pathEnvRemove('user', '/opt/A/bin');
    const profile = readFileSync(join(home, '.profile'), 'utf-8');
    expect(profile).toBe('# user content\n');
  });

  it('skips the rewrite when contents are unchanged (mtime preservation)', async () => {
    const p = new LinuxPlatform({ home });
    await p.pathEnvAdd('user', '/opt/X/bin');
    const path = join(home, '.profile');
    const before = statSync(path).mtimeMs;
    const start = Date.now();
    while (Date.now() - start < 20) {
      /* spin */
    }
    await p.pathEnvAdd('user', '/opt/X/bin');
    const after = statSync(path).mtimeMs;
    expect(after).toBe(before);
  });

  it('rejects HKLM (machine) PATH writes without elevation', async () => {
    const p = new LinuxPlatform({ home });
    await expect(p.pathEnvAdd('machine', '/opt/X/bin')).rejects.toThrow(/elevation/i);
  });
});

describe('LinuxPlatform — process liveness', () => {
  it('isPidAlive returns true for self', async () => {
    const p = new LinuxPlatform({ home });
    expect(await p.isPidAlive(process.pid)).toBe(true);
  });

  it('isPidAlive returns false for an obviously-dead PID', async () => {
    const p = new LinuxPlatform({ home });
    // PID 0 is the scheduler / kernel idle thread on Linux; sending
    // signal 0 to it returns EPERM rather than ESRCH on some kernels,
    // so use a high-but-very-unlikely-occupied PID instead.
    expect(await p.isPidAlive(2 ** 22 - 1)).toBe(false);
  });
});

describe('LinuxPlatform — file ops', () => {
  it('moveFile rejects existing destination by default', async () => {
    const p = new LinuxPlatform({ home });
    writeFileSync(join(home, 'a.txt'), 'A');
    writeFileSync(join(home, 'b.txt'), 'B');
    await expect(p.moveFile(join(home, 'a.txt'), join(home, 'b.txt'))).rejects.toThrow(/exists/);
  });

  it('moveFile overwrites when opts.overwrite is true', async () => {
    const p = new LinuxPlatform({ home });
    writeFileSync(join(home, 'a.txt'), 'A');
    writeFileSync(join(home, 'b.txt'), 'B');
    await p.moveFile(join(home, 'a.txt'), join(home, 'b.txt'), { overwrite: true });
    expect(readFileSync(join(home, 'b.txt'), 'utf-8')).toBe('A');
    expect(existsSync(join(home, 'a.txt'))).toBe(false);
  });

  it('fileSha256 returns the canonical hash', async () => {
    const p = new LinuxPlatform({ home });
    writeFileSync(join(home, 'x.txt'), 'abc');
    expect(await p.fileSha256(join(home, 'x.txt'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('LinuxPlatform — systemVars', () => {
  it('maps to XDG-style paths under the configured home', () => {
    const p = new LinuxPlatform({ home });
    const v = p.systemVars();
    expect(v.LocalAppData).toBe(join(home, '.local', 'share'));
    expect(v.Desktop).toBe(join(home, 'Desktop'));
    expect(v.StartMenu).toBe(join(home, '.local', 'share', 'applications'));
    expect(v.ProgramFiles).toBe('/opt');
  });
});
