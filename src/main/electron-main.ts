import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { join } from 'node:path';
import { mkdirSync, createWriteStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';
import * as yazl from 'yazl';

import { resolveHostPaths, ensureDevKeyPair, HOST_VERSION } from './host';
import { MockPlatform } from './platform';
import { createProgressThrottle } from './progress-throttle';
import { CatalogCache } from './catalog-cache';
import { fetchCatalog, fetchPackage } from './catalog-http';
import {
  createInstalledStore,
  createJournalStore,
  createTransactionRunner,
  parseVdxpkg,
  runInstall,
  runUninstall,
} from './engine';
import { loadVdxConfig } from './config/load-config';
import { createPackageSource } from './source/factory';
import {
  fetchCatalogVerified,
  fetchManifestVerified,
  fetchPayloadStream,
} from './catalog';
import { checkForHostUpdate, downloadHostUpdate } from './updater';
import {
  IpcChannels,
  SideloadOpenReq,
  InstallRunReq,
  UninstallRunReq,
  CatalogFetchReq,
  CatalogInstallReq,
  SettingsGetReq,
  SettingsSetReq,
  DiagExportReq,
  DiagOpenLogsReq,
  UpdateCheckReq,
  UpdateRunReq,
  type SideloadOpenResT,
  type InstallRunResT,
  type UninstallRunResT,
  type AppsListResT,
  type ProgressEventT,
  type CatalogFetchResT,
  type CatalogInstallResT,
  type CatalogKindT,
  type SettingsGetResT,
  type SettingsSetResT,
  type DiagExportResT,
  type DiagOpenLogsResT,
  type UpdateCheckResT,
  type UpdateRunResT,
} from '@shared/ipc-types';
import type { CatalogT, Manifest } from '@shared/schema';
import type { PackageSource } from '@shared/source/package-source';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/** Maximum number of concurrent sideload sessions before we evict the oldest. */
const MAX_SIDELOAD_SESSIONS = 8;

interface SideloadSession {
  manifest: Manifest;
  payloadBytes: Buffer;
  signatureValid: boolean;
  /** Tag the session so install:run can default the InstalledApp.kind correctly. */
  kind: CatalogKindT;
}
const sideloadSessions = new Map<string, SideloadSession>();

/** Evict the oldest session if the map is at capacity. */
function evictOldestSideloadSession(): void {
  if (sideloadSessions.size >= MAX_SIDELOAD_SESSIONS) {
    const oldest = sideloadSessions.keys().next().value;
    if (oldest !== undefined) sideloadSessions.delete(oldest);
  }
}

interface CatalogCacheEntry {
  catalog: CatalogT;
  /** Opaque ETag from the source for conditional re-fetch. */
  etag?: string | undefined;
  fetchedAt: string;
  signatureValid?: boolean;
  sourceUrl?: string;
}
// One entry per kind. R2 source backs the 'app' kind; the 'agent' kind is
// fetched directly from a static GitHub Pages URL (vdx.config.json
// `agentCatalog`). Both share the disk cache so cold-start tab opens are
// instant.
const catalogCacheEntries: Map<CatalogKindT, CatalogCacheEntry> = new Map();

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    backgroundColor: '#FBFBFA',
    title: 'VDX Installer',
    // Defer paint until the renderer has actually mounted. Prevents the
    // jarring "white flash → splash → real UI" sequence Electron defaults
    // to. With backgroundColor + show:false + ready-to-show the user sees
    // their themed canvas the first frame the window appears.
    show: false,
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

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

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
 * Allow only https: URLs through `shell.openExternal`. Without this gate
 * `setWindowOpenHandler` would happily launch `file://`, `vscode://`, or
 * other privileged Windows URI schemes — a code-execution sink reachable
 * from any markup the renderer rendered (e.g. a malicious manifest's
 * `supportUrl`). Plain http: is also rejected: design spec §6.6 mandates
 * https-only for any URL we hand to the OS browser, so a malicious manifest
 * can't redirect traffic through an attacker-controlled cleartext server.
 */
function isSafeExternalUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:';
}

/**
 * Forward a single progress event to the renderer. Bypasses the throttle —
 * use `progressThrottle.emit()` everywhere except from inside the throttle
 * itself.
 */
function sendProgressUnthrottled(ev: ProgressEventT): void {
  // Scope to mainWindow.webContents.id only — never broadcast to all windows.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannels.installProgress, ev);
  }
}

const progressThrottle = createProgressThrottle({
  intervalMs: 33, // ~30 Hz, plenty for human eyes, cheap on IPC
  forward: sendProgressUnthrottled,
});

function emitProgress(ev: ProgressEventT): void {
  progressThrottle.emit(ev);
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
  const installedStore = createInstalledStore(paths.installedJson, nodeFs, HOST_VERSION);
  const journalStore = createJournalStore(paths.journalDir, nodeFs);
  const platform = new MockPlatform();
  const runner = createTransactionRunner({ journal: journalStore });

  // Disk-backed catalog cache. Hydrated synchronously here so the very first
  // catalog:fetch IPC after launch can short-circuit on the cached body even
  // if the network is slow or down — the agents tab paints instantly with
  // yesterday's items.
  const catalogCache = new CatalogCache(paths.cacheDir);
  for (const kind of ['app', 'agent'] as const) {
    const hydrated = catalogCache.read(kind);
    if (hydrated) {
      catalogCacheEntries.set(kind, {
        catalog: hydrated.catalog,
        etag: hydrated.etag ?? undefined,
        fetchedAt: hydrated.fetchedAt,
        signatureValid: hydrated.signatureValid,
        sourceUrl: hydrated.sourceUrl,
      });
    }
  }

  // -----------------------------------------------------------------------
  // R2 config + source: resolve EXE-adjacent dir and appData dir per spec §6.
  // In production: exeDir = dirname(process.execPath).
  // In dev (electron-vite): process.execPath points to the dev electron binary;
  // use process.cwd() as the exe-adjacent fallback so vdx.config.json in the
  // project root is picked up during development.
  // -----------------------------------------------------------------------
  const exeDir = app.isPackaged
    ? join(process.execPath, '..')
    : process.cwd();
  const appDataDir = app.getPath('appData');

  const configResult = await loadVdxConfig({ exeDir, appDataDir });
  if (!configResult.ok) {
    // Hard failure at startup — surface to console and continue with no source.
    // In production a dialog would be shown; for Phase 1.1 this is acceptable.
    console.error('[vdx] Config load failed:', configResult.error.message);
    app.quit();
    return;
  }
  const config = configResult.value;

  // Instantiate the PackageSource from config.
  let packageSource: PackageSource;
  try {
    packageSource = await createPackageSource(config.source);
  } catch (e) {
    console.error('[vdx] Failed to create PackageSource:', (e as Error).message);
    app.quit();
    return;
  }

  // Trust roots: config.trustRoots (base64-encoded) + the dev key for Phase 1.1.
  const getTrustRoots = async (): Promise<Uint8Array[]> => {
    const roots: Uint8Array[] = [];
    if (config.trustRoots) {
      for (const b64 of config.trustRoots) {
        roots.push(Buffer.from(b64, 'base64'));
      }
    }
    // Always include the dev key as a trust root in Phase 1.1.
    roots.push(await getDevPubKey());
    return roots;
  };

  // -----------------------------------------------------------------------
  // IPC handlers
  // -----------------------------------------------------------------------

  ipcMain.handle(IpcChannels.appsList, async (): Promise<AppsListResT> => {
    const state = await installedStore.read();
    return state.apps;
  });

  ipcMain.handle(IpcChannels.pickVdxpkg, async () => {
    if (!mainWindow) return { canceled: true };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open .vdxpkg',
      filters: [{ name: 'VDX Package', extensions: ['vdxpkg'] }],
      properties: ['openFile'],
    });
    return result;
  });

  ipcMain.handle(IpcChannels.sideloadOpen, async (_e, raw): Promise<SideloadOpenResT> => {
    const parsed = SideloadOpenReq.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid request' };
    // Evict the oldest session if at capacity, then clear stale entries.
    evictOldestSideloadSession();
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

  // -----------------------------------------------------------------------
  // catalog:fetch — R2 PackageSource for 'app' kind; agentCatalog HTTP for 'agent'.
  // Both kinds share the on-disk CatalogCache so the next launch's first paint
  // in Apps/Agents shows yesterday's items instantly while a background refresh
  // (304-aware) reconciles ETags.
  // -----------------------------------------------------------------------
  ipcMain.handle(IpcChannels.catalogFetch, async (_e, raw): Promise<CatalogFetchResT> => {
    const parsed = CatalogFetchReq.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: 'invalid request', sourceUrl: null };
    }
    const kind = parsed.data.kind;

    if (kind === 'agent') {
      if (!config.agentCatalog) {
        return {
          ok: false,
          error:
            'No agentCatalog configured. Add { url, sigUrl } to vdx.config.json under "agentCatalog" pointing at your agent-catalog GitHub Pages.',
          sourceUrl: null,
        };
      }
      const cur = catalogCacheEntries.get('agent');
      const result = await fetchCatalog({
        url: config.agentCatalog.url,
        sigUrl: config.agentCatalog.sigUrl,
        publicKey: await getDevPubKey(),
        timeoutMs: 15_000,
        userAgent: `vdx-installer/${HOST_VERSION}`,
        ifNoneMatch: cur?.etag ?? null,
      });
      if (!result.ok) return { ok: false, error: result.error, sourceUrl: config.agentCatalog.url };

      // 304: keep the cached body but refresh fetchedAt / etag.
      if (result.value.notModified && cur) {
        const refreshed: CatalogCacheEntry = {
          ...cur,
          fetchedAt: result.value.fetchedAt,
          etag: result.value.etag ?? cur.etag,
        };
        catalogCacheEntries.set('agent', refreshed);
        catalogCache?.write('agent', refreshed);
        return {
          ok: true,
          catalog: cur.catalog,
          signatureValid: cur.signatureValid ?? true,
          fetchedAt: result.value.fetchedAt,
          sourceUrl: config.agentCatalog.url,
        };
      }

      const entry: CatalogCacheEntry = {
        catalog: result.value.catalog,
        etag: result.value.etag ?? undefined,
        fetchedAt: result.value.fetchedAt,
        signatureValid: result.value.signatureValid,
        sourceUrl: config.agentCatalog.url,
      };
      catalogCacheEntries.set('agent', entry);
      catalogCache?.write('agent', entry);
      return {
        ok: true,
        catalog: result.value.catalog,
        signatureValid: result.value.signatureValid,
        fetchedAt: result.value.fetchedAt,
        sourceUrl: config.agentCatalog.url,
      };
    }

    // kind === 'app' — R2 PackageSource path.
    try {
      const trustRoots = await getTrustRoots();
      const cur = catalogCacheEntries.get('app');
      const result = await fetchCatalogVerified(packageSource, {
        trustRoots,
        cachedEtag: cur?.etag,
      });

      if ('notModified' in result) {
        if (!cur) {
          return {
            ok: false,
            error: 'Catalog not modified but no cached copy found.',
            sourceUrl: packageSource.displayName,
          };
        }
        return {
          ok: true,
          catalog: cur.catalog,
          signatureValid: cur.signatureValid ?? true,
          fetchedAt: cur.fetchedAt,
          sourceUrl: packageSource.displayName,
        };
      }

      const fetchedAt = new Date().toISOString();
      const entry: CatalogCacheEntry = {
        catalog: result.catalog,
        etag: result.etag,
        fetchedAt,
        signatureValid: true,
        sourceUrl: packageSource.displayName,
      };
      catalogCacheEntries.set('app', entry);
      catalogCache?.write('app', entry);

      return {
        ok: true,
        catalog: result.catalog,
        signatureValid: true,
        fetchedAt,
        sourceUrl: packageSource.displayName,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message, sourceUrl: packageSource.displayName };
    }
  });

  // -----------------------------------------------------------------------
  // catalog:install — R2 implementation using PackageSource + fetchManifestVerified
  // -----------------------------------------------------------------------
  ipcMain.handle(IpcChannels.catalogInstall, async (_e, raw): Promise<CatalogInstallResT> => {
    const parsed = CatalogInstallReq.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid request' };

    const kind = parsed.data.kind;
    const cur = catalogCacheEntries.get(kind);
    if (!cur) {
      return { ok: false, error: 'Catalog not loaded yet — refresh the catalog tab first.' };
    }
    const item = cur.catalog.apps.find((a) => a.id === parsed.data.appId);
    if (!item) return { ok: false, error: `Item not in catalog: ${parsed.data.appId}` };

    try {
      const trustRoots = await getTrustRoots();

      // Use latestVersion from catalog item to resolve manifest + payload.
      const version = item.latestVersion ?? 'latest';

      // Agent kind: catalog item supplies a direct packageUrl. We bypass the
      // R2 source (which targets the App-catalog repo) and let parseVdxpkg
      // handle the manifest+sig+payload trio in the downloaded .vdxpkg.
      if (kind === 'agent') {
        if (!item.packageUrl) {
          return {
            ok: false,
            error: `Agent catalog entry '${item.id}' lacks packageUrl. Add a direct .vdxpkg URL.`,
          };
        }
        emitProgress({ phase: 'download', message: 'Downloading…', downloadedBytes: 0, percent: 0 });
        const pkgRes = await fetchPackage({
          url: item.packageUrl,
          timeoutMs: 60_000,
          userAgent: `vdx-installer/${HOST_VERSION}`,
          onProgress: ({ downloadedBytes, totalBytes }) => {
            const percent =
              totalBytes && totalBytes > 0
                ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 100))
                : undefined;
            emitProgress({
              phase: 'download',
              message: 'Downloading…',
              downloadedBytes,
              ...(totalBytes !== null ? { totalBytes } : {}),
              ...(percent !== undefined ? { percent } : {}),
            });
          },
        });
        if (!pkgRes.ok) return { ok: false, error: pkgRes.error };
        emitProgress({ phase: 'verify', message: 'Verifying signature…', percent: 100 });
        const parseRes = await parseVdxpkg(pkgRes.value, await getDevPubKey());
        if (!parseRes.ok) return { ok: false, error: parseRes.error };

        evictOldestSideloadSession();
        const sessionId = randomUUID();
        sideloadSessions.set(sessionId, {
          manifest: parseRes.value.manifest,
          payloadBytes: parseRes.value.payloadBytes,
          signatureValid: parseRes.value.signatureValid,
          kind: 'agent',
        });
        const sysVars = platform.systemVars();
        const defaultInstallPath = `${sysVars.LocalAppData}/Programs/Samsung/${parseRes.value.manifest.id}`;
        return {
          ok: true,
          manifest: parseRes.value.manifest,
          defaultInstallPath,
          signatureValid: parseRes.value.signatureValid,
          sessionId,
          kind: 'agent',
        };
      }

      // kind === 'app' — full R2 source path (manifest + sig + payload by URL convention).
      let manifest: Manifest;
      try {
        manifest = await fetchManifestVerified(packageSource, item.id, version, {
          trustRoots,
        });
      } catch (e) {
        return { ok: false, error: `Manifest fetch failed: ${(e as Error).message}` };
      }

      // Stream payload into a Buffer for parseVdxpkg compatibility.
      // fetchPayloadStream verifies SHA-256 inline. sha256 lives at manifest.payload.sha256.
      // We emit `download` progress as bytes arrive; the throttle ensures
      // at most ~30 IPC roundtrips per second even for fast networks.
      const sha256 = manifest.payload.sha256;
      const totalBytes = manifest.payload.compressedSize;
      const chunks: Uint8Array[] = [];
      let downloaded = 0;
      emitProgress({
        phase: 'download',
        message: 'Downloading…',
        downloadedBytes: 0,
        totalBytes,
        percent: 0,
      });
      try {
        for await (const chunk of fetchPayloadStream(packageSource, item.id, version, {
          expectedSha256: sha256,
        })) {
          chunks.push(chunk);
          downloaded += chunk.byteLength;
          const percent = totalBytes > 0 ? Math.min(99, Math.round((downloaded / totalBytes) * 100)) : undefined;
          emitProgress({
            phase: 'download',
            message: 'Downloading…',
            downloadedBytes: downloaded,
            totalBytes,
            ...(percent !== undefined ? { percent } : {}),
          });
        }
      } catch (e) {
        return { ok: false, error: `Payload fetch failed: ${(e as Error).message}` };
      }
      emitProgress({
        phase: 'verify',
        message: 'Verifying signature…',
        downloadedBytes: downloaded,
        totalBytes,
        percent: 100,
      });

      const payloadBytes = Buffer.concat(chunks);

      // Parse the .vdxpkg-style payload bytes (ZIP) through the engine
      const parseRes = await parseVdxpkg(payloadBytes, await getDevPubKey());
      if (!parseRes.ok) return { ok: false, error: parseRes.error };

      evictOldestSideloadSession();
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

  // -----------------------------------------------------------------------
  // settings:get / settings:set
  // -----------------------------------------------------------------------

  ipcMain.handle(IpcChannels.settingsGet, async (_e, raw): Promise<SettingsGetResT> => {
    const parsed = SettingsGetReq.safeParse(raw ?? {});
    if (!parsed.success) return { ok: false, error: 'invalid request' };
    try {
      const state = await installedStore.read();
      return { ok: true, settings: state.settings };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(IpcChannels.settingsSet, async (_e, raw): Promise<SettingsSetResT> => {
    const parsed = SettingsSetReq.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid request' };
    try {
      const updated = await installedStore.update((s) => {
        Object.assign(s.settings, parsed.data.patch);
      });
      return { ok: true, settings: updated.settings };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  // -----------------------------------------------------------------------
  // diag:export — bundle logs to a ZIP archive using yazl
  // -----------------------------------------------------------------------

  ipcMain.handle(IpcChannels.diagExport, async (_e, raw): Promise<DiagExportResT> => {
    const parsed = DiagExportReq.safeParse(raw ?? {});
    if (!parsed.success) return { ok: false, error: 'invalid request' };
    try {
      const archivePath = join(paths.cacheDir, `vdx-diag-${Date.now()}.zip`);
      await new Promise<void>((resolve, reject) => {
        const zipFile = new yazl.ZipFile();
        const outStream = createWriteStream(archivePath);
        zipFile.outputStream.pipe(outStream);
        outStream.on('close', resolve);
        outStream.on('error', reject);
        zipFile.outputStream.on('error', reject);

        void (async () => {
          try {
            const logFiles = await readdir(paths.logsDir);
            for (const name of logFiles) {
              if (!name.endsWith('.log') && !name.endsWith('.ndjson')) continue;
              zipFile.addFile(join(paths.logsDir, name), `logs/${name}`);
            }
          } catch {
            // logsDir may not yet have files — not fatal
          }
          zipFile.end();
        })();
      });
      return { ok: true, archivePath };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  // -----------------------------------------------------------------------
  // diag:open-logs — open the logs directory in the OS file manager
  // -----------------------------------------------------------------------

  ipcMain.handle(IpcChannels.diagOpenLogs, async (_e, raw): Promise<DiagOpenLogsResT> => {
    const parsed = DiagOpenLogsReq.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid request' };
    try {
      await shell.openPath(paths.logsDir);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  // -----------------------------------------------------------------------
  // update:check — query PackageSource for a newer host version
  // -----------------------------------------------------------------------

  ipcMain.handle(IpcChannels.updateCheck, async (_e, raw): Promise<UpdateCheckResT> => {
    const parsed = UpdateCheckReq.safeParse(raw ?? {});
    if (!parsed.success) return { ok: false, error: 'invalid request' };
    try {
      const selfUpdateConfig =
        config.source.type === 'github' && config.source.github
          ? { repo: config.source.github.selfUpdateRepo }
          : null;
      const info = await checkForHostUpdate({
        source: packageSource,
        selfUpdateConfig,
        currentVersion: HOST_VERSION,
        channel: config.channel,
      });
      return { ok: true, info };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  // -----------------------------------------------------------------------
  // update:run — download the update and log a TODO for Phase 1.2 restart
  // -----------------------------------------------------------------------

  ipcMain.handle(IpcChannels.updateRun, async (_e, raw): Promise<UpdateRunResT> => {
    const parsed = UpdateRunReq.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid request' };
    try {
      const selfUpdateConfig =
        config.source.type === 'github' && config.source.github
          ? { repo: config.source.github.selfUpdateRepo }
          : null;
      const info = await checkForHostUpdate({
        source: packageSource,
        selfUpdateConfig,
        currentVersion: HOST_VERSION,
        channel: config.channel,
      });
      if (!info) return { ok: false, error: 'No update available' };

      const destPath = join(paths.cacheDir, `vdx-installer-${info.latestVersion}.staged`);
      await downloadHostUpdate(info, {
        source: packageSource,
        destPath,
        // Phase 1.1: SHA-256 comes from the manifest fetched by checkForHostUpdate.
        // For Phase 1.2 this must be verified against a trusted manifest signature.
        // TODO (Phase 1.2): read expectedSha256 from the verified manifest.
        expectedSha256: '',
      });

      // TODO (Phase 1.2): Authenticode verification + replace-on-restart:
      //   app.relaunch({ execPath: destPath });
      //   app.quit();
      console.info('[vdx] update:run: Phase 1.1 — download complete. Phase 1.2 replace-on-restart not yet implemented.');

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
