import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getAutoLaunch,
  setAutoLaunch,
  wasLaunchedHidden,
} from '@main/auto-launch';

describe('setAutoLaunch (Windows / macOS)', () => {
  it('forwards to setLoginItemSettings on win32 with hidden + args', () => {
    const set = vi.fn();
    const r = setAutoLaunch(true, { platform: 'win32', setLoginItem: set, hidden: true });
    expect(r.ok).toBe(true);
    expect(set).toHaveBeenCalledWith({
      openAtLogin: true,
      openAsHidden: true,
      args: ['--hidden'],
    });
  });

  it('forwards to setLoginItemSettings on darwin without hidden flag', () => {
    const set = vi.fn();
    setAutoLaunch(true, { platform: 'darwin', setLoginItem: set });
    expect(set).toHaveBeenCalledWith({ openAtLogin: true });
  });

  it('disables via openAtLogin: false', () => {
    const set = vi.fn();
    setAutoLaunch(false, { platform: 'win32', setLoginItem: set });
    expect(set).toHaveBeenCalledWith({
      openAtLogin: false,
      openAsHidden: true,
      args: ['--hidden'],
    });
  });

  it('reads back via getLoginItemSettings', () => {
    expect(
      getAutoLaunch({ platform: 'win32', getLoginItem: () => ({ openAtLogin: true }) }),
    ).toBe(true);
    expect(
      getAutoLaunch({ platform: 'darwin', getLoginItem: () => ({ openAtLogin: false }) }),
    ).toBe(false);
  });

  it('reports unsupported-platform on freebsd / openbsd / etc', () => {
    const r = setAutoLaunch(true, { platform: 'freebsd' as NodeJS.Platform });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('unsupported-platform');
  });
});

describe('setAutoLaunch (Linux)', () => {
  const fakeHomes: string[] = [];
  function makeHome(): string {
    const d = mkdtempSync(join(tmpdir(), 'vdx-autolaunch-'));
    fakeHomes.push(d);
    return d;
  }
  // No afterAll cleanup hook — vitest's process tear-down handles it,
  // and these dirs are inside tmpdir which the OS cycles regularly.

  it('writes ~/.config/autostart/vdx-installer.desktop on enable', () => {
    const home = makeHome();
    const r = setAutoLaunch(true, {
      platform: 'linux',
      home,
      execPath: '/opt/vdx-installer/vdx-installer',
    });
    expect(r.ok).toBe(true);
    const path = join(home, '.config/autostart/vdx-installer.desktop');
    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path, 'utf-8');
    expect(body).toMatch(/^\[Desktop Entry\]/);
    expect(body).toMatch(/Exec=\/opt\/vdx-installer\/vdx-installer --hidden/);
    expect(body).toMatch(/X-GNOME-Autostart-enabled=true/);
  });

  it('removes the .desktop file on disable', () => {
    const home = makeHome();
    setAutoLaunch(true, { platform: 'linux', home });
    const path = join(home, '.config/autostart/vdx-installer.desktop');
    expect(existsSync(path)).toBe(true);
    setAutoLaunch(false, { platform: 'linux', home });
    expect(existsSync(path)).toBe(false);
  });

  it('disable on a host that was never enabled is a no-op', () => {
    const home = makeHome();
    const r = setAutoLaunch(false, { platform: 'linux', home });
    expect(r.ok).toBe(true);
  });

  it('does not rewrite the file when contents are identical (mtime preservation)', () => {
    const home = makeHome();
    setAutoLaunch(true, { platform: 'linux', home, execPath: '/opt/x' });
    const path = join(home, '.config/autostart/vdx-installer.desktop');
    const beforeStat = require('node:fs').statSync(path).mtimeMs;
    // Sleep enough that mtime would visibly change if we wrote.
    const start = Date.now();
    while (Date.now() - start < 20) {
      /* spin */
    }
    setAutoLaunch(true, { platform: 'linux', home, execPath: '/opt/x' });
    const afterStat = require('node:fs').statSync(path).mtimeMs;
    expect(afterStat).toBe(beforeStat);
  });

  it('rewrites the file when the exec path changes', () => {
    const home = makeHome();
    setAutoLaunch(true, { platform: 'linux', home, execPath: '/opt/old' });
    setAutoLaunch(true, { platform: 'linux', home, execPath: '/opt/new' });
    const body = readFileSync(
      join(home, '.config/autostart/vdx-installer.desktop'),
      'utf-8',
    );
    expect(body).toMatch(/Exec=\/opt\/new/);
  });

  it('getAutoLaunch on Linux reflects file presence', () => {
    const home = makeHome();
    expect(getAutoLaunch({ platform: 'linux', home })).toBe(false);
    setAutoLaunch(true, { platform: 'linux', home });
    expect(getAutoLaunch({ platform: 'linux', home })).toBe(true);
    setAutoLaunch(false, { platform: 'linux', home });
    expect(getAutoLaunch({ platform: 'linux', home })).toBe(false);
  });

  // Cleanup at end of suite — explicit since we don't use afterAll.
  it('cleanup', () => {
    for (const d of fakeHomes) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});

describe('wasLaunchedHidden', () => {
  it('returns true when --hidden is present', () => {
    expect(wasLaunchedHidden(['/opt/electron', 'app', '--hidden'])).toBe(true);
  });
  it('returns false otherwise', () => {
    expect(wasLaunchedHidden(['/opt/electron', 'app'])).toBe(false);
  });
});
