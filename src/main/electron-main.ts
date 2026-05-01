import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } from 'electron';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';

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
import { checkCatalogFreshness, getFreshnessAnchor } from './catalog/freshness';
import { resolveTrustRoots } from './config/trust-roots';
import { handleSettingsGet, handleSettingsSet } from './ipc/handlers/settings';
import { handleUpdateApply, handleUpdateCheck, handleUpdateRun } from './ipc/handlers/update';
import {
  handleAppsCheckUpdates,
  handleAppsUpdateRun,
} from './ipc/handlers/apps-update';
import { disposeTray, installTray, notifyUpdateReady, resolveTrayIconPath } from './tray';
import { handleDiagExport, handleDiagOpenLogs } from './ipc/handlers/diag';
import { handleAuthSetToken, handleAuthClearToken } from './ipc/handlers/auth';
import { handleAppsList } from './ipc/handlers/apps';
import { createPickerAllowlist } from './ipc/picker-allowlist';
import { computeCsp } from './ipc/csp';
import { ipcError, ipcErrorMessage } from './ipc/error';
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
  type ProgressEventT,
  type CatalogFetchResT,
  type CatalogInstallResT,
  type CatalogKindT,
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

/**
 * Picker allowlist — gates `sideload:open` to paths the user just chose via
 * the OS file dialog. Implementation lives in `./ipc/picker-allowlist.ts`
 * with its own test coverage; the cap defaults to 16 there.
 */
const pickerAllowlist = createPickerAllowlist();

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

/**
 * In-flight fetches per kind. A user spam-clicking refresh launches
 * overlapping handlers; without this dedup, response B (newer fetch) can
 * complete first and write to the cache, then response A (older fetch,
 * server lag) lands later and clobbers the cache back to a stale state —
 * including a stale ETag that primes the next conditional GET wrong.
 * Concurrent calls now share the first in-flight promise.
 */
const catalogInflight: Map<CatalogKindT, Promise<CatalogFetchResT>> = new Map();

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
  // and Vite does not inject one in dev. The actual policy strings live in
  // `./ipc/csp.ts` with their own test coverage.
  const csp = computeCsp(Boolean(process.env['ELECTRON_RENDERER_URL']));
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

  // Sweep stale journal entries from prior crashes. These are transactions
  // that were `pending` / `extracting` / etc. when the process died. We
  // surface them through the log so support bundles capture the orphan;
  // automatic rollback would need the original installPath + platform
  // context, which we don't have, so it's deferred to a Phase 1.2 UI flow
  // that asks the user before discarding work.
  try {
    const orphans = await runner.recoverPending();
    if (orphans.length > 0) {
      console.warn(
        `[vdx] recoverPending: ${orphans.length} pending transaction(s) from prior crash; surface via UI in Phase 1.2`,
        orphans.map((t) => ({ txid: t.txid, appId: t.appId, status: t.status })),
      );
    }
  } catch (e) {
    console.error('[vdx] recoverPending failed:', (e as Error).message);
  }

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
    // resolveTrustRoots handles the bare-string + object-form union and drops
    // any object-form root whose validity window is closed. Without `asOf`
    // it uses Date.now() — fine for runtime checks; the catalog/manifest
    // verifier passes the catalog's own updatedAt for "as-of" semantics.
    const roots = resolveTrustRoots(config, {
      devPubKey: includeDevKey ? await getDevPubKey() : null,
    });
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

  ipcMain.handle(IpcChannels.appsList, () => handleAppsList({ installedStore }));

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
      for (const p of result.filePaths) pickerAllowlist.remember(p);
    }
    return result;
  });

  ipcMain.handle(IpcChannels.sideloadOpen, async (_e, raw): Promise<SideloadOpenResT> => {
    const parsed = SideloadOpenReq.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid request' };
    // Picker allowlist: only paths returned by `sideload:pick` may be opened.
    // Without this gate the renderer can name any user-readable file and we
    // would `readFileSync` it — effectively turning IPC into `fs.readFile`.
    // Single-use semantics: claim consumes the entry so a stale path can't
    // be replayed.
    if (!pickerAllowlist.claim(parsed.data.vdxpkgPath)) {
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
      return ipcError(e);
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
      const msg = ipcErrorMessage(e);
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
    // De-dup concurrent fetches of the same kind. Any caller arriving while
    // a fetch is in flight awaits the first one's result instead of issuing
    // its own request that could race.
    const existing = catalogInflight.get(kind);
    if (existing) return existing;
    const work = doCatalogFetch(kind);
    catalogInflight.set(kind, work);
    try {
      return await work;
    } finally {
      catalogInflight.delete(kind);
    }
  });

  async function doCatalogFetch(kind: CatalogKindT): Promise<CatalogFetchResT> {
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

      // Replay defense: if the incoming catalog's updatedAt is older than the
      // highest anchor we've ever seen for this kind, refuse. A signed-but-
      // stale body can otherwise be re-served indefinitely.
      const stateForFreshness = await installedStore.read();
      const fresh = checkCatalogFreshness(
        result.value.catalog.updatedAt,
        getFreshnessAnchor(stateForFreshness, 'agent'),
      );
      if (!fresh.ok) {
        return { ok: false, error: fresh.reason ?? 'replay refused', sourceUrl: config.agentCatalog.url };
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
      // Advance the anchor only when the body was signature-validated. An
      // unverified catalog must not poison the anchor — otherwise a single
      // unsigned MITM response would lock subsequent verified responses out.
      if (result.value.signatureValid) {
        await installedStore.update((s) => {
          if (!s.catalogFreshness) s.catalogFreshness = {};
          s.catalogFreshness.agent = result.value.catalog.updatedAt;
        });
      }
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

      // Replay defense — same logic as the agent path. fetchCatalogVerified
      // throws on bad sig so we know `result.catalog` here is signature-valid.
      const stateForFreshness = await installedStore.read();
      const fresh = checkCatalogFreshness(
        result.catalog.updatedAt,
        getFreshnessAnchor(stateForFreshness, 'app'),
      );
      if (!fresh.ok) {
        return { ok: false, error: fresh.reason ?? 'replay refused', sourceUrl: packageSource.displayName };
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
      await installedStore.update((s) => {
        if (!s.catalogFreshness) s.catalogFreshness = {};
        s.catalogFreshness.app = result.catalog.updatedAt;
      });

      return {
        ok: true,
        catalog: result.catalog,
        signatureValid: true,
        fetchedAt,
        sourceUrl: packageSource.displayName,
      };
    } catch (e) {
      return { ok: false, error: ipcErrorMessage(e), sourceUrl: packageSource.displayName };
    }
  }

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

        // Bind the click on "install <item.id>" to the manifest's claim of
        // identity. A tampered (but signed-by-a-trusted-publisher) catalog
        // entry could swap `packageUrl` to a different signed app — the
        // inner manifest sig would still verify but the user installed the
        // wrong thing. Refuse if id or version disagree.
        if (parseRes.value.manifest.id !== item.id) {
          return {
            ok: false,
            error: `Catalog/manifest id mismatch: catalog says '${item.id}', manifest says '${parseRes.value.manifest.id}'`,
          };
        }
        if (item.latestVersion && parseRes.value.manifest.version !== item.latestVersion) {
          return {
            ok: false,
            error: `Catalog/manifest version mismatch: catalog says '${item.latestVersion}', manifest says '${parseRes.value.manifest.version}'`,
          };
        }

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
        return { ok: false, error: `Manifest fetch failed: ${ipcErrorMessage(e)}` };
      }
      // Same id/version binding check as the agent path. The fetch URL is
      // bound to (item.id, version), but the manifest body itself is just
      // bytes — defensively verify the body's own claims match the URL
      // coordinates so a misconfigured source can't substitute.
      if (manifest.id !== item.id) {
        return {
          ok: false,
          error: `Catalog/manifest id mismatch: catalog says '${item.id}', manifest says '${manifest.id}'`,
        };
      }
      if (manifest.version !== version) {
        return {
          ok: false,
          error: `Catalog/manifest version mismatch: requested '${version}', manifest says '${manifest.version}'`,
        };
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
        return { ok: false, error: `Payload fetch failed: ${ipcErrorMessage(e)}` };
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
      return ipcError(e);
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
        wizardAnswers: app2.wizardAnswers,
      });
      if (!res.ok) return { ok: false, error: res.error };
      await installedStore.update((s) => {
        delete s.apps[parsed.data.appId];
      });
      return { ok: true };
    } catch (e) {
      return ipcError(e);
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

  const diagDeps = { paths: { cacheDir: paths.cacheDir, logsDir: paths.logsDir }, shell };
  ipcMain.handle(IpcChannels.diagExport, (_e, raw) => handleDiagExport(diagDeps, raw));
  ipcMain.handle(IpcChannels.diagOpenLogs, (_e, raw) => handleDiagOpenLogs(diagDeps, raw));

  // -----------------------------------------------------------------------
  // update:check — query PackageSource for a newer host version
  // -----------------------------------------------------------------------

  // Track the most-recently-staged update so update:apply can find the file.
  // Lifetime is the host process: no need to persist — a relaunch either
  // succeeds (new host doesn't need to know about the old staged file) or
  // fails (next launch can re-run update:check + update:run).
  let stagedUpdateVersion: string | null = null;
  const updateDeps = {
    packageSource,
    config,
    hostVersion: HOST_VERSION,
    cacheDir: paths.cacheDir,
    activeTransactions: () => activeTransactions,
    getTrustRoots,
    quit: () => app.quit(),
    getStagedVersion: () => stagedUpdateVersion,
    setStagedVersion: (v: string | null) => {
      stagedUpdateVersion = v;
    },
  };
  ipcMain.handle(IpcChannels.updateCheck, (_e, raw) => handleUpdateCheck(updateDeps, raw));
  ipcMain.handle(IpcChannels.updateRun, (_e, raw) => handleUpdateRun(updateDeps, raw));
  ipcMain.handle(IpcChannels.updateApply, (_e, raw) => handleUpdateApply(updateDeps, raw));

  // Background self-update polling. Fires once at startup (5 s after launch
  // so the first paint isn't blocked by the network) and every 6 hours
  // thereafter. Each tick calls `update:check`; if a newer version exists
  // and one wasn't already announced, broadcast `update:available` so the
  // renderer can show its badge. We never *download* in the background —
  // that's the user's explicit click on update:run, to keep the bandwidth
  // and disk decisions opt-in.
  let lastAnnouncedVersion: string | null = null;
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  const pollSelfUpdate = async (): Promise<void> => {
    try {
      const res = await handleUpdateCheck(updateDeps, {});
      if (!res.ok || !res.info) return;
      if (res.info.latestVersion === lastAnnouncedVersion) return;
      lastAnnouncedVersion = res.info.latestVersion;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IpcChannels.updateAvailable, res.info);
      }
    } catch {
      // Background poll never raises to the user — they will discover it
      // on the next manual click.
    }
  };
  setTimeout(() => {
    void pollSelfUpdate();
  }, 5_000);
  const pollInterval = setInterval(() => {
    void pollSelfUpdate();
  }, SIX_HOURS_MS);
  app.on('before-quit', () => clearInterval(pollInterval));

  // -----------------------------------------------------------------------
  // apps:checkUpdates / apps:updateRun — per-installed-app update flow.
  //
  // The handler reuses the catalog:install pipeline by routing through a
  // closure that calls the same IPC body the renderer would. This keeps
  // signature verification, payload streaming, and session bookkeeping in
  // exactly one place — there is no second install code path to keep in
  // sync.
  // -----------------------------------------------------------------------

  const triggerCatalogInstallProgrammatically = async (
    kind: CatalogKindT,
    appId: string,
  ): Promise<CatalogInstallResT> => {
    const handler = ipcMain.listeners(IpcChannels.catalogInstall)[0] as
      | ((event: unknown, raw: unknown) => Promise<CatalogInstallResT>)
      | undefined;
    if (!handler) {
      return { ok: false, error: 'catalog:install handler not registered yet' };
    }
    return handler(undefined, { kind, appId });
  };

  const appsUpdateDeps = {
    readInstalled: async () => (await installedStore.read()).apps,
    getCatalog: (kind: CatalogKindT) => catalogCacheEntries.get(kind)?.catalog ?? null,
    channel: () => 'stable' as 'stable' | 'beta' | 'internal',
    triggerCatalogInstall: triggerCatalogInstallProgrammatically,
  };
  ipcMain.handle(IpcChannels.appsCheckUpdates, (_e, raw) =>
    handleAppsCheckUpdates(appsUpdateDeps, raw),
  );
  ipcMain.handle(IpcChannels.appsUpdateRun, (_e, raw) => handleAppsUpdateRun(appsUpdateDeps, raw));

  // Broadcast app-update candidates after every catalog refresh. We
  // re-check on a 6 h cadence (same as host self-update poll) plus
  // immediately after each catalog:fetch IPC succeeds. The renderer
  // dedups by candidate-set fingerprint internally.
  let lastCandidateFingerprint = '';
  const broadcastAppUpdates = async (): Promise<void> => {
    try {
      const res = await handleAppsCheckUpdates(appsUpdateDeps, {});
      if (!res.ok) return;
      const fp = JSON.stringify(
        res.candidates.map((c) => `${c.appId}:${c.fromVersion}>${c.toVersion}`).sort(),
      );
      if (fp === lastCandidateFingerprint) return;
      lastCandidateFingerprint = fp;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IpcChannels.appsUpdatesAvailable, {
          candidates: res.candidates,
        });
      }
    } catch {
      /* silent — same as host poll */
    }
  };
  setTimeout(() => {
    void broadcastAppUpdates();
  }, 6_000);
  const appsPollInterval = setInterval(() => {
    void broadcastAppUpdates();
  }, SIX_HOURS_MS);
  app.on('before-quit', () => clearInterval(appsPollInterval));

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

  const authDeps = {
    authStorePath: paths.authStore,
    safeStorage,
    fs: { writeFileSync, existsSync, unlinkSync },
  };
  ipcMain.handle(IpcChannels.authSetToken, (_e, raw) => handleAuthSetToken(authDeps, raw));
  ipcMain.handle(IpcChannels.authClearToken, (_e, raw) => handleAuthClearToken(authDeps, raw));

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

  // Tray + notifications. The icon is hidden by default; the user opts in
  // via Settings → trayMode (which we honor on next launch). Phase 2 will
  // make this dynamic without restart by exposing an IPC toggle.
  const initialTrayMode = (await installedStore.read()).settings.trayMode;
  if (initialTrayMode) {
    installTray({
      getWindow: () => mainWindow,
      triggerUpdateCheck: async () => {
        await pollSelfUpdate();
      },
      iconPath: resolveTrayIconPath() ?? undefined,
    });
  }
  app.on('before-quit', () => disposeTray());

  // Notify when an update becomes ready (post-download, pre-restart).
  // Hooked to the same `update:available → update:run → ready` path: we
  // tag a marker so the next time the renderer transitions to ready we
  // also fire an OS notification. Done in main rather than renderer so it
  // works even if the user is in another app.
  let lastReadyVersionNotified: string | null = null;
  const watchUpdateReady = setInterval(() => {
    if (initialTrayMode === false) return;
    if (stagedUpdateVersion && stagedUpdateVersion !== lastReadyVersionNotified) {
      lastReadyVersionNotified = stagedUpdateVersion;
      notifyUpdateReady(stagedUpdateVersion);
    }
  }, 5_000);
  app.on('before-quit', () => clearInterval(watchUpdateReady));
}

void main();
