import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';

import { resolveHostPaths, ensureDevKeyPair, HOST_VERSION } from './host';
import { MockPlatform } from './platform';
import {
  createInstalledStore,
  createJournalStore,
  createTransactionRunner,
  parseVdxpkg,
  runInstall,
  runUninstall,
} from './engine';
import {
  IpcChannels,
  SideloadOpenReq,
  InstallRunReq,
  UninstallRunReq,
  type SideloadOpenResT,
  type InstallRunResT,
  type UninstallRunResT,
  type AppsListResT,
  type ProgressEventT,
} from '@shared/ipc-types';
import type { Manifest } from '@shared/schema';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

interface SideloadSession {
  manifest: Manifest;
  payloadBytes: Buffer;
  signatureValid: boolean;
}
const sideloadSessions = new Map<string, SideloadSession>();

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    backgroundColor: '#FBFBFA',
    title: 'VDX Installer',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.removeMenu();

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function emitProgress(ev: ProgressEventT): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannels.installProgress, ev);
  }
}

async function main(): Promise<void> {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  await app.whenReady();

  const paths = resolveHostPaths();
  for (const dir of [paths.cacheDir, paths.logsDir, paths.locksDir, paths.journalDir, paths.keysDir]) {
    mkdirSync(dir, { recursive: true });
  }
  const { pub: devPubKey } = await ensureDevKeyPair(paths.keysDir);

  // Phase 1.1: still using MockPlatform during dev. Real Windows platform is Phase 1.2.
  // The installed-store, journal-store, and lock files use the real node fs through MockPlatform's
  // memfs-typed signature — but here we want them to write to the real disk so user data persists
  // across launches. So we instantiate them with `nodeFs` directly.
  const installedStore = createInstalledStore(paths.installedJson, nodeFs, HOST_VERSION);
  const journalStore = createJournalStore(paths.journalDir, nodeFs);
  const platform = new MockPlatform();
  const runner = createTransactionRunner({ journal: journalStore });

  ipcMain.handle(IpcChannels.appsList, async (): Promise<AppsListResT> => {
    const state = await installedStore.read();
    return state.apps;
  });

  ipcMain.handle(IpcChannels.pickVdxpkg, async () => {
    if (!mainWindow) return { canceled: true };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open .vdxpkg',
      filters: [{ name: 'VDX Package', extensions: ['vdxpkg', 'zip'] }],
      properties: ['openFile'],
    });
    return result;
  });

  ipcMain.handle(IpcChannels.sideloadOpen, async (_e, raw): Promise<SideloadOpenResT> => {
    const parsed = SideloadOpenReq.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid request' };
    try {
      const bytes = nodeFs.readFileSync(parsed.data.vdxpkgPath);
      const result = await parseVdxpkg(bytes, devPubKey);
      if (!result.ok) return { ok: false, error: result.error };
      const sessionId = randomUUID();
      sideloadSessions.set(sessionId, {
        manifest: result.value.manifest,
        payloadBytes: result.value.payloadBytes,
        signatureValid: result.value.signatureValid,
      });
      const sysVars = platform.systemVars();
      const defaultInstallPath = `${sysVars.LocalAppData}/Programs/Samsung/${result.value.manifest.id}`;
      return {
        ok: true,
        manifest: result.value.manifest,
        defaultInstallPath,
        signatureValid: result.value.signatureValid,
        sessionId,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(IpcChannels.installRun, async (_e, raw): Promise<InstallRunResT> => {
    const parsed = InstallRunReq.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid request' };
    const session = sideloadSessions.get(parsed.data.sessionId);
    if (!session) return { ok: false, error: 'session expired or unknown' };
    try {
      emitProgress({ phase: 'extract', message: 'Extracting payload...', percent: 10 });
      const installRes = await runInstall({
        manifest: session.manifest,
        payloadBytes: session.payloadBytes,
        wizardAnswers: parsed.data.wizardAnswers,
        platform,
        runner,
        hostExePath: process.execPath,
      });
      if (!installRes.ok) {
        emitProgress({ phase: 'error', message: installRes.error });
        return { ok: false, error: installRes.error };
      }
      emitProgress({ phase: 'commit', message: 'Finalizing...', percent: 90 });
      await installedStore.update((s) => {
        s.apps[session.manifest.id] = {
          version: session.manifest.version,
          installScope: session.manifest.installScope.default,
          installPath: installRes.value.installPath,
          wizardAnswers: parsed.data.wizardAnswers,
          journal: installRes.value.committed.steps,
          manifestSnapshot: session.manifest,
          installedAt: new Date().toISOString(),
          updateChannel: 'stable',
          autoUpdate: 'ask',
          source: 'sideload',
        };
      });
      emitProgress({ phase: 'done', message: 'Installed', percent: 100 });
      sideloadSessions.delete(parsed.data.sessionId);
      return { ok: true, installPath: installRes.value.installPath };
    } catch (e) {
      const msg = (e as Error).message;
      emitProgress({ phase: 'error', message: msg });
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(IpcChannels.uninstallRun, async (_e, raw): Promise<UninstallRunResT> => {
    const parsed = UninstallRunReq.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid request' };
    try {
      const state = await installedStore.read();
      const app2 = state.apps[parsed.data.appId];
      if (!app2) return { ok: false, error: 'app not installed' };
      const res = await runUninstall({
        manifest: app2.manifestSnapshot,
        installPath: app2.installPath,
        journalEntries: app2.journal,
        platform,
        runner,
        scope: app2.installScope,
      });
      if (!res.ok) return { ok: false, error: res.error };
      await installedStore.update((s) => {
        delete s.apps[parsed.data.appId];
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  createWindow();
}

void main();
