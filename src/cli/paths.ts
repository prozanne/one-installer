/**
 * CLI paths — Electron-free port of `src/main/host.ts#resolveHostPaths`.
 *
 * The Electron host uses `app.getPath('userData')` which resolves to
 * %APPDATA%/<name> on Windows, ~/Library/Application Support/<name> on
 * macOS, and ~/.config/<name> on Linux. The CLI needs the same data
 * directory so `vdx install` from the terminal observes the same
 * `installed.json` the GUI does.
 *
 * We replicate the resolution rules manually rather than spawning Electron.
 * Honors XDG_DATA_HOME on Linux per the spec.
 */
import * as os from 'node:os';
import * as path from 'node:path';

export interface CliPaths {
  userData: string;
  installedJson: string;
  cacheDir: string;
  logsDir: string;
  locksDir: string;
  journalDir: string;
  keysDir: string;
  authStore: string;
}

const APP_NAME = 'vdx-installer';

export function resolveCliPaths(): CliPaths {
  const userData = resolveUserDataDir();
  return {
    userData,
    installedJson: path.join(userData, 'installed.json'),
    cacheDir: path.join(userData, 'cache'),
    logsDir: path.join(userData, 'logs'),
    locksDir: path.join(userData, 'locks'),
    journalDir: path.join(userData, 'journal'),
    keysDir: path.join(userData, 'keys'),
    authStore: path.join(userData, 'auth.bin'),
  };
}

function resolveUserDataDir(): string {
  const home = os.homedir();
  switch (process.platform) {
    case 'win32': {
      const appdata = process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming');
      return path.join(appdata, APP_NAME);
    }
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', APP_NAME);
    default: {
      // Linux + freebsd + everyone else — XDG.
      const xdg = process.env['XDG_DATA_HOME'] ?? path.join(home, '.config');
      return path.join(xdg, APP_NAME);
    }
  }
}
