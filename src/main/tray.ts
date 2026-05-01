/**
 * System tray integration. Renders a small icon in the OS tray with a
 * compact menu so the host can run quietly in the background:
 *
 *   - Open VDX Installer  (raises the main window if hidden)
 *   - Check for updates   (manual force of update:check)
 *   - Quit                (real exit, not just hide)
 *
 * Visibility is gated by the `trayMode` setting. When the user disables
 * it, `dispose()` removes the icon and unregisters the menu so we don't
 * keep a hidden Electron resource around.
 *
 * Native notification helpers (`notifyUpdateAvailable` / `notifyInstalled`)
 * fire transient toasts via the OS notification system. They're separate
 * from the tray itself — the tray icon is persistent UI, notifications
 * are transient. Both respect the same `trayMode` setting since users
 * who don't want the tray icon also don't want background toasts.
 */
import { app, Menu, Notification, Tray, nativeImage, type BrowserWindow } from 'electron';
import { accessSync } from 'node:fs';
import { join } from 'node:path';

let tray: Tray | null = null;

export interface TrayDeps {
  /** The main BrowserWindow — clicked tray entries raise/show it. */
  getWindow: () => BrowserWindow | null;
  /** Trigger an update check the same way the renderer would (just calls handleUpdateCheck). */
  triggerUpdateCheck: () => Promise<void>;
  /**
   * Path to the tray icon PNG. Phase 2.5 will ship a real branded icon;
   * for now we accept any path the caller resolves (electron-builder
   * places `resources/icon.png` next to the EXE).
   */
  iconPath?: string;
}

/**
 * Build the small monochrome icon used in the tray. macOS in particular
 * wants a template image (single-color, alpha-channel masked) so the
 * icon picks up dark/light mode automatically. We use a 16×16 PNG of a
 * teal "V" — synthesized as a tiny base64 fallback if no iconPath is
 * supplied, so dev environments don't crash on missing assets.
 */
function buildTrayIcon(iconPath?: string): Electron.NativeImage {
  if (iconPath) {
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) {
      // Mark as template on macOS so menu-bar tinting works automatically.
      if (process.platform === 'darwin') img.setTemplateImage(true);
      return img;
    }
  }
  // Fallback: 1×1 transparent PNG. Tray will render the system default
  // (a small gray square on Windows/Linux). Better than crashing.
  const fallback = nativeImage.createFromBuffer(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAYAAfPBxhQAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  return fallback;
}

export function installTray(deps: TrayDeps): void {
  if (tray) return; // already installed
  tray = new Tray(buildTrayIcon(deps.iconPath));
  tray.setToolTip('VDX Installer');
  const rebuildMenu = () => {
    const menu = Menu.buildFromTemplate([
      {
        label: 'Open VDX Installer',
        click: () => {
          const w = deps.getWindow();
          if (!w) return;
          if (w.isMinimized()) w.restore();
          w.show();
          w.focus();
        },
      },
      {
        label: 'Check for updates',
        click: () => {
          void deps.triggerUpdateCheck();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          // Use exit() rather than quit() to bypass `before-quit` listeners
          // that might `event.preventDefault()` (e.g. a hide-on-close hook
          // we'll add when trayMode goes mainstream).
          app.exit(0);
        },
      },
    ]);
    tray?.setContextMenu(menu);
  };
  rebuildMenu();
  // Single click on Windows / Linux raises the window. macOS uses the
  // menu by default so we leave it.
  if (process.platform !== 'darwin') {
    tray.on('click', () => {
      const w = deps.getWindow();
      if (!w) return;
      if (w.isVisible()) w.hide();
      else {
        w.show();
        w.focus();
      }
    });
  }
}

export function disposeTray(): void {
  if (!tray) return;
  tray.destroy();
  tray = null;
}

/**
 * Resolve the bundled tray icon path. In production the icon is alongside
 * the EXE under `resources/`; in dev (electron-vite) we look in the
 * project's `build/` directory. Returns null if the icon doesn't exist —
 * the tray falls back to the synthesized placeholder.
 */
export function resolveTrayIconPath(): string | null {
  const candidate = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(process.cwd(), 'build', 'icon.png');
  try {
    accessSync(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Fire a transient OS notification when a new host version is staged or
 * an install completes. Silent on platforms where Notification.isSupported()
 * is false (very rare — basically only headless environments).
 */
export function notifyUpdateReady(version: string): void {
  if (!Notification.isSupported()) return;
  new Notification({
    title: 'VDX Installer 업데이트 준비됨',
    body: `v${version} 가 다운로드되었습니다. 사이드바에서 "지금 재시작"을 눌러주세요.`,
    silent: false,
  }).show();
}

export function notifyInstallComplete(displayName: string, version: string): void {
  if (!Notification.isSupported()) return;
  new Notification({
    title: '설치 완료',
    body: `${displayName} v${version}`,
    silent: true,
  }).show();
}
