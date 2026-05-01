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
import { loadConfig } from './config';
import { fetchCatalog, fetchPackage } from './catalog-http';
import {
  IpcChannels,
  SideloadOpenReq,
  InstallRunReq,
  UninstallRunReq,
  CatalogFetchReq,
  CatalogInstallReq,
  type SideloadOpenResT,
  type InstallRunResT,
  type UninstallRunResT,
  type AppsListResT,
  type ProgressEventT,
  type CatalogFetchResT,
  type CatalogInstallResT,
  type CatalogKindT,
} from '@shared/ipc-types';
import type { CatalogT, Manifest } from '@shared/schema';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

interface SideloadSession {
  manifest: Manifest;
  payloadBytes: Buffer;
  signatureValid: boolean;
  /** Tag the session so install:run can default the InstalledApp.kind correctly. */
  kind: CatalogKindT;
}
const sideloadSessions = new Map<string, SideloadSession>();

interface CatalogCacheEntry {
  catalog: CatalogT;
  signatureValid: boolean;
  fetchedAt: string;
  sourceUrl: string;
}
const catalogCache = new Map<CatalogKindT, CatalogCacheEntry>();

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
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
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
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Allow only the dev server URL or the local file load. Anything else —
    // a redirect from a malicious link, a programmatic location.href set —
    // would otherwise navigate the BrowserWindow off our origin.
    const allowedDev = process.env['ELECTRON_RENDERER_URL'];
    if (allowedDev && url.startsWith(allowedDev)) return;
    if (url.startsWith('file://')) return;
    event.preventDefault();
  });

  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

/**
 * Allow only http/https URLs through `shell.openExternal`. Without this gate
 * `setWindowOpenHandler` would happily launch `file://`, `vscode://`, or
 * other privileged Windows URI schemes — a code-execution sink reachable
 * from any markup the renderer rendered (e.g. a malicious manifest's
 * `supportUrl`).
 */
function isSafeExternalUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:';
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
  // Lazy-load the dev keypair: first cold start used to block ~50–100ms on
  // Ed25519 generation before paint. We only need the pubkey at sideload
  // verification time, so defer until then and memoise the result.
  let devPubKeyCache: Uint8Array | null = null;
  const getDevPubKey = async (): Promise<Uint8Array> => {
    if (devPubKeyCache) return devPubKeyCache;
    const { pub } = await ensureDevKeyPair(paths.keysDir);
    devPubKeyCache = pub;
    return pub;
  };

  // Phase 1.1: still using MockPlatform during dev. Real Windows platform is Phase 1.2.
  // The installed-store, journal-store, and lock files use the real node fs through MockPlatform's
  // memfs-typed signature — but here we want them to write to the real disk so user data persists
  // across launches. So we instantiate them with `nodeFs` directly.
  const installedStore = createInstalledStore(paths.installedJson, nodeFs, HOST_VERSION);
  const journalStore = createJournalStore(paths.journalDir, nodeFs);
  const platform = new MockPlatform();
  const runner = createTransactionRunner({ journal: journalStore });
  // Catalog URLs come from vdx.config.json (next to the EXE in production, or
  // the project root in dev). Defaults are placeholders pointing at the
  // canonical org names — operators MUST override before shipping.
  const config = loadConfig([process.cwd(), join(__dirname, '../..')]);

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
    // Only one sideload session is meaningful at a time; clear stale entries
    // before opening a new one so a user who opens-then-cancels-then-opens
    // doesn't accumulate Buffer-sized leaks.
    sideloadSessions.clear();
    try {
      const bytes = nodeFs.readFileSync(parsed.data.vdxpkgPath);
      const result = await parseVdxpkg(bytes, await getDevPubKey());
      if (!result.ok) return { ok: false, error: result.error };
      const sessionId = randomUUID();
      sideloadSessions.set(sessionId, {
        manifest: result.value.manifest,
        payloadBytes: result.value.payloadBytes,
        signatureValid: result.value.signatureValid,
        kind: 'app',
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
    // Always release the session (and its full payload Buffer) when this
    // handler returns — success, validation failure, or thrown exception.
    // Without this the cancel-from-wizard path leaks the entire ZIP until
    // process exit.
    try {
      emitProgress({ phase: 'extract', message: 'Extracting payload...', percent: 10 });
      const installRes = await runInstall({
        manifest: session.manifest,
        payloadBytes: session.payloadBytes,
        wizardAnswers: parsed.data.wizardAnswers,
        platform,
        runner,
        hostExePath: process.execPath,
        lockDir: paths.locksDir,
      });
      if (!installRes.ok) {
        emitProgress({ phase: 'error', message: installRes.error });
        return { ok: false, error: installRes.error };
      }
      emitProgress({ phase: 'commit', message: 'Finalizing...', percent: 90 });
      // The session's `kind` (app vs agent) is the authoritative tag.
      // Renderer-supplied `parsed.data.kind` is only used as a fallback
      // when the session was a plain sideload (no catalog provenance).
      const installedKind = session.kind === 'agent' ? 'agent' : parsed.data.kind;
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
          source: session.kind === 'agent' ? 'catalog' : 'sideload',
          kind: installedKind,
        };
      });
      emitProgress({ phase: 'done', message: 'Installed', percent: 100 });
      return { ok: true, installPath: installRes.value.installPath };
    } catch (e) {
      const msg = (e as Error).message;
      emitProgress({ phase: 'error', message: msg });
      return { ok: false, error: msg };
    } finally {
      sideloadSessions.delete(parsed.data.sessionId);
    }
  });

  ipcMain.handle(IpcChannels.catalogFetch, async (_e, raw): Promise<CatalogFetchResT> => {
    const parsed = CatalogFetchReq.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: 'invalid request', sourceUrl: null };
    }
    const target = config.catalogs[parsed.data.kind];
    try {
      const result = await fetchCatalog({
        url: target.url,
        sigUrl: target.sigUrl,
        publicKey: await getDevPubKey(),
        timeoutMs: config.network.timeoutMs,
        userAgent: config.network.userAgent,
      });
      if (!result.ok) return { ok: false, error: result.error, sourceUrl: target.url };
      catalogCache.set(parsed.data.kind, {
        catalog: result.value.catalog,
        signatureValid: result.value.signatureValid,
        fetchedAt: result.value.fetchedAt,
        sourceUrl: target.url,
      });
      return {
        ok: true,
        catalog: result.value.catalog,
        signatureValid: result.value.signatureValid,
        fetchedAt: result.value.fetchedAt,
        sourceUrl: target.url,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message, sourceUrl: target.url };
    }
  });

  ipcMain.handle(IpcChannels.catalogInstall, async (_e, raw): Promise<CatalogInstallResT> => {
    const parsed = CatalogInstallReq.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid request' };
    const cache = catalogCache.get(parsed.data.kind);
    if (!cache) {
      // Force the renderer to refresh first; we refuse to silently re-fetch
      // here because that path would also need spinner UI feedback that the
      // current call doesn't have.
      return { ok: false, error: 'Catalog not loaded yet — refresh the catalog tab first.' };
    }
    const item = cache.catalog.apps.find((a) => a.id === parsed.data.appId);
    if (!item) return { ok: false, error: `Item not in catalog: ${parsed.data.appId}` };
    if (!item.packageUrl) {
      // Phase 2 will resolve `repo` via the GitHub Releases API; for now we
      // require an explicit packageUrl. Return an actionable error so an
      // operator editing catalog.json knows what to add.
      return {
        ok: false,
        error: `Catalog entry '${item.id}' lacks packageUrl. Add a direct .vdxpkg URL or wait for Phase 2.`,
      };
    }
    sideloadSessions.clear();
    try {
      const pkgRes = await fetchPackage({
        url: item.packageUrl,
        timeoutMs: config.network.timeoutMs,
        userAgent: config.network.userAgent,
      });
      if (!pkgRes.ok) return { ok: false, error: pkgRes.error };
      const parseRes = await parseVdxpkg(pkgRes.value, await getDevPubKey());
      if (!parseRes.ok) return { ok: false, error: parseRes.error };
      const sessionId = randomUUID();
      sideloadSessions.set(sessionId, {
        manifest: parseRes.value.manifest,
        payloadBytes: parseRes.value.payloadBytes,
        signatureValid: parseRes.value.signatureValid,
        kind: parsed.data.kind,
      });
      const sysVars = platform.systemVars();
      const defaultInstallPath = `${sysVars.LocalAppData}/Programs/Samsung/${parseRes.value.manifest.id}`;
      return {
        ok: true,
        manifest: parseRes.value.manifest,
        defaultInstallPath,
        signatureValid: parseRes.value.signatureValid,
        sessionId,
        kind: parsed.data.kind,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
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
        lockDir: paths.locksDir,
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
