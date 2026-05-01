/**
 * Cross-platform "start at login" toggle.
 *
 * Windows / macOS — defer to Electron's `app.setLoginItemSettings()`.
 *   - Win32: writes to HKCU\Software\Microsoft\Windows\CurrentVersion\Run
 *     (per-user, no UAC needed).
 *   - macOS: registers a LaunchAgent via the OS service-management API.
 *
 * Linux — Electron's setLoginItemSettings is unreliable across desktop
 * environments, so we drop a freedesktop.org-spec autostart .desktop file
 * at `~/.config/autostart/vdx-installer.desktop`. Most modern DEs (GNOME,
 * KDE, XFCE, Cinnamon, MATE, Pantheon) honor this directory.
 *
 * The `--hidden` flag in args asks the host to start in tray-only mode so
 * the user isn't ambushed by a window every time they log in. Renderer
 * boots the same way; main reads the flag and skips `mainWindow.show()`
 * until the user actually opens the tray entry.
 */
import { app } from 'electron';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const LINUX_AUTOSTART_FILE = '.config/autostart/vdx-installer.desktop';

export interface AutoLaunchOpts {
  /**
   * If true, the host will start hidden (tray-only). Defaults true; the
   * autostart entry shouldn't pop a window in the user's face on login.
   */
  hidden?: boolean;
  /**
   * Override the platform string. Production omits; tests pass 'linux' /
   * 'darwin' / 'win32' to exercise each branch.
   */
  platform?: NodeJS.Platform;
  /**
   * Override `app.setLoginItemSettings` for tests. Production omits.
   */
  setLoginItem?: typeof app.setLoginItemSettings;
  /**
   * Override `app.getLoginItemSettings` for tests.
   */
  getLoginItem?: () => { openAtLogin: boolean };
  /**
   * Override the absolute path to the host EXE for the .desktop Exec=
   * field. Production passes `process.execPath`. Tests pass any path so
   * the .desktop write can be inspected without touching real Electron.
   */
  execPath?: string;
  /**
   * Override the home directory; tests use a tmpdir to avoid touching the
   * real user's autostart dir.
   */
  home?: string;
}

export type AutoLaunchResult =
  | { ok: true }
  | { ok: false; error: string; code: 'unsupported-platform' | 'fs-error' };

/**
 * Enable or disable autostart at login. Idempotent — calling enable twice
 * is fine, and disable on a host that was never enabled is a no-op.
 */
export function setAutoLaunch(enabled: boolean, opts: AutoLaunchOpts = {}): AutoLaunchResult {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32' || platform === 'darwin') {
    const set = opts.setLoginItem ?? app.setLoginItemSettings.bind(app);
    try {
      set({
        openAtLogin: enabled,
        // Windows-only fields: hidden start + the cmd-line flag main reads
        // to know it should boot into tray-only mode.
        ...(platform === 'win32'
          ? { openAsHidden: opts.hidden ?? true, args: ['--hidden'] }
          : {}),
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message, code: 'fs-error' };
    }
  }
  if (platform === 'linux') {
    return setAutoLaunchLinux(enabled, opts);
  }
  return {
    ok: false,
    error: `auto-launch not supported on ${platform}`,
    code: 'unsupported-platform',
  };
}

/**
 * Read current autostart state. Used by the Settings page so the toggle
 * reflects the actual on-disk reality (a manual `rm` of the .desktop
 * file should make the toggle move back to OFF on next read).
 */
export function getAutoLaunch(opts: AutoLaunchOpts = {}): boolean {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32' || platform === 'darwin') {
    const get = opts.getLoginItem ?? (() => app.getLoginItemSettings());
    try {
      return get().openAtLogin;
    } catch {
      return false;
    }
  }
  if (platform === 'linux') {
    const home = opts.home ?? homedir();
    return existsSync(join(home, LINUX_AUTOSTART_FILE));
  }
  return false;
}

function setAutoLaunchLinux(enabled: boolean, opts: AutoLaunchOpts): AutoLaunchResult {
  const home = opts.home ?? homedir();
  const desktopPath = join(home, LINUX_AUTOSTART_FILE);
  if (!enabled) {
    try {
      if (existsSync(desktopPath)) unlinkSync(desktopPath);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message, code: 'fs-error' };
    }
  }
  // Compose the .desktop file. Hidden=false because the file presence IS
  // what enables autostart; the more confusing X-GNOME-Autostart-enabled
  // toggle is for "user toggled this off in gnome-tweaks" which we don't
  // currently surface — settings.startOnLogin is the single source of
  // truth and writes the file unconditionally on enable.
  const exec = opts.execPath ?? process.execPath;
  const hidden = opts.hidden ?? true;
  const args = hidden ? ' --hidden' : '';
  const contents =
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=VDX Installer',
      'Comment=Samsung VDX Installer',
      `Exec=${exec}${args}`,
      'Icon=vdx-installer',
      'Terminal=false',
      'Categories=Utility;System;',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n');
  try {
    mkdirSync(dirname(desktopPath), { recursive: true });
    // Compare-then-write so we don't churn the mtime on every settings
    // re-save. Some indexers (Tracker, Baloo) treat mtime change as a
    // re-index trigger.
    let same = false;
    try {
      same = readFileSync(desktopPath, 'utf-8') === contents;
    } catch {
      same = false;
    }
    if (!same) writeFileSync(desktopPath, contents, { mode: 0o644 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message, code: 'fs-error' };
  }
}

/**
 * Convenience: was the host invoked with the `--hidden` flag the
 * autostart entry adds? Main checks this before showing the window
 * for the first time on launch.
 */
export function wasLaunchedHidden(argv: readonly string[] = process.argv): boolean {
  return argv.includes('--hidden');
}
