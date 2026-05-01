import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } from 'electron';
import { join } from 'node:path';
import { mkdirSync, createWriteStream, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
import { checkForHostUpdate, downloadHostUpdate, SELF_UPDATE_APP_ID } from './updater';
import { handleSettingsGet, handleSettingsSet } from './ipc/handlers/settings';
import { handleUpdateCheck, handleUpdateRun } from './ipc/handlers/update';
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
  AuthSetTokenReq,
  AuthClearTokenReq,
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
  type AuthSetTokenResT,
  type AuthClearTokenResT,
} from '@shared/ipc-types';
import type { CatalogT, Manifest } from '@shared/schema';
import type { PackageSource } from '@shared/source/package-source';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/** Maximum number of concurrent sideload sessions before we evict the oldest. */
const MAX_SIDELOAD_SESSIONS = 8;

/**
 * Maximum number of file paths the picker can publish before the oldest is
 * evicted. Caps the worst-case "spam pickVdxpkg" memory growth — the renderer
 * cannot accumulate an unbounded allowlist of paths it might one day claim.
 */
const MAX_PICKED_PATHS = 16;

interface SideloadSession {
  manifest: Manifest;
  payloadBytes: Buffer;
  signatureValid: boolean;
  /** Tag the session so install:run can default the InstalledApp.kind correctly. */
  kind: CatalogKindT;
}
const sideloadSessions = new Map<string, SideloadSession>();

/**
 * Paths that `sideload:pick` has handed back to the renderer. `sideload:open`
 * only honors paths in this set — without this gate the renderer would have
 * an IPC-exposed `fs.readFile` for any user-readable file the OS will allow.
 * Each entry is single-use: claimed by `sideload:open` and removed.
 */
const pickedPaths = new Set<string>();

/**
 * Refcount of in-flight install / uninstall / catalogInstall operations.
 * `update:run` must refuse while any of these are in flight (applying a
 * host-update mid-install leaves journal/transaction state inconsistent
 * across the relaunch boundary).
 *
 * Counter (not boolean) so that two overlapping installs can't release the
 * mutex prematurely: if A and B both increment, A's `finally` decrements
 * to 1, and `update:run` correctly still sees `> 0` while B continues.
 */
let activeTransactions = 0;
function beginTransaction(): void {
  activeTransactions++;
}
function endTransaction(): void {
  if (activeTransactions > 0) activeTransactions--;
}

function rememberPickedPath(p: string): void {
  if (pickedPaths.size >= MAX_PICKED_PATHS) {
    const oldest = pickedPaths.values().next().value;
    if (oldest !== undefined) pickedPaths.delete(oldest);
  }
  pickedPaths.add(p);
}

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

  // Strict CSP. Setting it via webRequest is the only way to enforce it for
  // both the prod file:// load and the dev http://localhost Vite load — a
  // <meta> tag in index.html is too late for some sources (e.g. preconnects)
  // and Vite does not inject one in dev. `connect-src 'none'` blocks any
  // accidental fetch() from the renderer; all network is supposed to go
  // through main via IPC. `style-src 'unsafe-inline'` is required by React's
  // injected style tags; everything else is locked down.
  // Dev relaxations: Vite/HMR loads modules over ws: and inline-eval; only
  // applied when ELECTRON_RENDERER_URL is set so prod builds stay strict.
  const csp = process.env['ELECTRON_RENDERER_URL']
    ? "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:* ws://localhost:*; style-src 'self' 'unsafe-inline'; img-src 'self' data: http://localhost:*; connect-src 'self' ws://localhost:* http://localhost:*; font-src 'self' data:"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; font-src 'self' data:";
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });

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

  // Compute the exact renderer entry-point URL once. Anything other than this
  // file (and, in dev, the Vite dev server's exact origin) is a navigation we
  // do not authorize: arbitrary `file://` URLs could otherwise reach
  // `file:///C:/Windows/...`, and a prefix match on the dev origin would let
  // `http://localhost:51730/evil` slip past `http://localhost:5173`.
  const rendererFileUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).href;
  const allowedDevOrigin = (() => {
    const devUrl2 = process.env['ELECTRON_RENDERER_URL'];
    if (!devUrl2) return null;
    try {
      return new URL(devUrl2).origin;
    } catch {
      return null;
    }
  })();

  mainWindow.webContents.on('will-navigate', (event, url) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      event.preventDefault();
      return;
    }
    if (allowedDevOrigin && target.origin === allowedDevOrigin) return;
    if (url === rendererFileUrl) return;
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

  // Trust roots: config.trustRoots (base64-encoded) is the primary trust anchor.
  // The per-device dev keypair is included only when (a) the build is unpacked
  // (i.e. running from `electron .` in dev) or (b) the operator's vdx.config.json
  // explicitly enabled developerMode. A packaged production build with default
  // config will never accept signatures from a locally generated key — that's
  // critique F-12. If config.trustRoots is empty in a packaged build, signature
  // verification will fail loudly rather than silently fall back.
  const includeDevKey = !app.isPackaged || config.developerMode;
  if (app.isPackaged && config.developerMode) {
    // A production build with developerMode active means the operator's
    // vdx.config.json is granting trust to the per-device dev keypair, which
    // signs *anything* this machine generates. That's the right tool for IT
    // staging but a footgun in user hands — flag it loudly at every startup
    // so a misplaced config doesn't sit unnoticed in a fleet rollout.
    console.warn(
      '[vdx-installer] WARNING: developerMode=true in vdx.config.json. ' +
        'The per-device dev key is being added to trust roots. ' +
        'This must NOT be enabled in user-facing builds.',
    );
  }
  const getTrustRoots = async (): Promise<Uint8Array[]> => {
    const roots: Uint8Array[] = [];
    if (config.trustRoots) {
      for (const b64 of config.trustRoots) {
        roots.push(Buffer.from(b64, 'base64'));
      }
    }
    if (includeDevKey) roots.push(await getDevPubKey());
    if (roots.length === 0) {
      // Never silently accept anything. If the operator forgot to ship trust
      // roots in a packaged build, surface a fatal error here so the failure
      // is visible at boot, not during the first signature check.
      throw new Error(
        'No trust roots available — set vdx.config.json `trustRoots` or enable developerMode',
      );
    }
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
    // Remember every path the user actually selected so `sideload:open` can
    // verify the renderer is asking for a file the picker just handed it.
    if (!result.canceled) {
      for (const p of result.filePaths) rememberPickedPath(p);
    }
    return result;
  });

  ipcMain.handle(IpcChannels.sideloadOpen, async (_e, raw): Promise<SideloadOpenResT> => {
    const parsed = SideloadOpenReq.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid request' };
    // Picker allowlist: only paths returned by `sideload:pick` may be opened.
    // Without this gate the renderer can name any user-readable file and we
    // would `readFileSync` it — effectively turning IPC into `fs.readFile`.
    // Single-use semantics: claim+remove so a stale path can't be replayed.
    if (!pickedPaths.delete(parsed.data.vdxpkgPath)) {
      return { ok: false, error: 'unauthorized path — open the file via the picker dialog' };
    }
    evictOldestSideloadSession();
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
    beginTransaction();
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
      endTransaction();
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
        // Verify against the operator's full trust-root union, not just the
        // dev key. Agent catalog signature must satisfy the same trust chain
        // as the app catalog. (F-12 fix for agent kind.)
        trustRoots: await getTrustRoots(),
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
    // Refuse to install from an unverified catalog. A tampered catalog could
    // swap an entry's `packageUrl` to point at a different (still-Samsung-signed)
    // app — the inner manifest sig would still verify, but the user would have
    // installed something other than what they clicked. The signature on the
    // catalog itself is what binds the displayed name → packageUrl mapping.
    if (cur.signatureValid !== true) {
      return {
        ok: false,
        error:
          'Catalog signature is not verified for this session. ' +
          'Refresh the catalog tab from a trusted network before installing.',
      };
    }
    const item = cur.catalog.apps.find((a) => a.id === parsed.data.appId);
    if (!item) return { ok: false, error: `Item not in catalog: ${parsed.data.appId}` };

    beginTransaction();
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
        // Verify the inner manifest signature against the operator's full
        // trust-root union — not the dev key alone. Catalog-installed agents
        // must satisfy the same trust chain as anything else fetched from a
        // configured source. (F-12 fix for the agent kind.)
        const parseRes = await parseVdxpkg(pkgRes.value, await getTrustRoots());
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

      // Parse the .vdxpkg-style payload bytes (ZIP) through the engine.
      // Inner manifest signature verified against the trust-root union (F-12);
      // the outer manifest was already verified by fetchManifestVerified.
      const parseRes = await parseVdxpkg(payloadBytes, await getTrustRoots());
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
    } finally {
      endTransaction();
    }
  });

  ipcMain.handle(IpcChannels.uninstallRun, async (_e, raw): Promise<UninstallRunResT> => {
    const parsed = UninstallRunReq.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid request' };
    beginTransaction();
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
    } finally {
      endTransaction();
    }
  });

  // -----------------------------------------------------------------------
  // settings:get / settings:set
  // -----------------------------------------------------------------------

  const settingsDeps = { installedStore };
  ipcMain.handle(IpcChannels.settingsGet, (_e, raw) => handleSettingsGet(settingsDeps, raw));
  ipcMain.handle(IpcChannels.settingsSet, (_e, raw) => handleSettingsSet(settingsDeps, raw));

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
      // Reveal the archive in the OS file manager from main, so the renderer
      // never receives a path string. The user still gets visual confirmation
      // ("here's your zip"), but the process boundary stays one-way.
      shell.showItemInFolder(archivePath);
      return { ok: true };
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

  const updateDeps = {
    packageSource,
    config,
    hostVersion: HOST_VERSION,
    cacheDir: paths.cacheDir,
    activeTransactions: () => activeTransactions,
    getTrustRoots,
  };
  ipcMain.handle(IpcChannels.updateCheck, (_e, raw) => handleUpdateCheck(updateDeps, raw));
  ipcMain.handle(IpcChannels.updateRun, (_e, raw) => handleUpdateRun(updateDeps, raw));

  // -----------------------------------------------------------------------
  // auth:setToken / auth:clearToken — first-run PAT flow.
  //
  // Tokens are encrypted with Electron safeStorage (Keychain on macOS,
  // DPAPI on Windows, libsecret on Linux). The encrypted blob lives at
  // paths.authStore. We never store the plaintext; we never echo it back
  // to the renderer. If safeStorage is unavailable on the platform (rare —
  // requires libsecret on Linux), set/clear fail rather than fall back to
  // plaintext storage. Failing closed is the safer default for a credential.
  // -----------------------------------------------------------------------

  ipcMain.handle(IpcChannels.authSetToken, async (_e, raw): Promise<AuthSetTokenResT> => {
    const parsed = AuthSetTokenReq.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid request' };
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'OS secure storage unavailable on this system' };
    }
    try {
      const encrypted = safeStorage.encryptString(parsed.data.token);
      // mode 0o600 best-effort — POSIX only; Windows ACLs already restrict the
      // userData dir to the current user account.
      writeFileSync(paths.authStore, encrypted, { mode: 0o600 });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(IpcChannels.authClearToken, async (_e, raw): Promise<AuthClearTokenResT> => {
    const parsed = AuthClearTokenReq.safeParse(raw ?? {});
    if (!parsed.success) return { ok: false, error: 'invalid request' };
    try {
      if (existsSync(paths.authStore)) unlinkSync(paths.authStore);
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
