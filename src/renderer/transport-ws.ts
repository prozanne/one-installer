/**
 * Browser-side WebSocket transport that polyfills the same `window.vdxIpc`
 * shape the Electron preload would provide.
 *
 * Why a polyfill instead of a separate code path: every page, store, and
 * component already calls `window.vdxIpc.xxx()`. Routing those through
 * a transport interface that branches on Electron-vs-browser would double
 * the surface every channel author has to learn. Single shape, two
 * transports — the polyfill is loaded only when there's no preload.
 *
 * Auth: the page is served with `?token=…`. We stash that into
 * sessionStorage on first load (so refreshes don't drop it) and append
 * it to the WebSocket URL on connect. Forgetting the token requires a
 * full re-launch of the headless server (which generates a fresh token
 * each time).
 */
import { IpcChannels } from '@shared/ipc-types';
import type {
  AppsListResT,
  SideloadOpenResT,
  InstallRunReqT,
  InstallRunResT,
  UninstallRunReqT,
  UninstallRunResT,
  ProgressEventT,
  CatalogFetchReqT,
  CatalogFetchResT,
  CatalogInstallReqT,
  CatalogInstallResT,
  SettingsGetReqT,
  SettingsGetResT,
  SettingsSetReqT,
  SettingsSetResT,
  DiagExportResT,
  DiagOpenLogsResT,
  UpdateApplyResT,
  UpdateAvailableEventT,
  UpdateCheckResT,
  UpdateRunResT,
  AppsCheckUpdatesResT,
  AppsUpdateRunReqT,
  AppsUpdateRunResT,
  AppsUpdatesAvailableEventT,
  HostSetAutoLaunchReqT,
  HostSetAutoLaunchResT,
  HostGetAutoLaunchResT,
  AuthSetTokenReqT,
  AuthSetTokenResT,
  AuthClearTokenResT,
} from '@shared/ipc-types';

type ServerFrame =
  | { kind: 'rpc-result'; id: string; result: unknown }
  | { kind: 'rpc-error'; id: string; error: string }
  | { kind: 'event'; channel: string; payload: unknown };

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

const TOKEN_KEY = 'vdx.headlessToken';

function readToken(): string {
  const fromUrl = new URL(window.location.href).searchParams.get('token');
  if (fromUrl) {
    try {
      sessionStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      /* private mode etc — fall back to in-memory only */
    }
    return fromUrl;
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

interface TransportState {
  ws: WebSocket | null;
  /** Resolved when the WS reaches OPEN. Re-created on each reconnect attempt. */
  ready: Promise<void>;
  pending: Map<string, Pending>;
  subscribers: Map<string, Set<(payload: unknown) => void>>;
  /** Backoff in ms for the next reconnect; doubles up to 30s. */
  nextBackoffMs: number;
}

function createTransport(): TransportState {
  const state: TransportState = {
    ws: null,
    ready: Promise.resolve(),
    pending: new Map(),
    subscribers: new Map(),
    nextBackoffMs: 500,
  };

  const connect = () => {
    const token = readToken();
    if (!token) {
      // No token, no transport. Pages will see "loading…" forever which
      // matches the "URL was opened without ?token=" error case better
      // than a confusing connection failure.
      return;
    }
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${wsProto}//${window.location.host}/?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    state.ws = ws;
    state.ready = new Promise<void>((resolveReady) => {
      ws.addEventListener('open', () => {
        state.nextBackoffMs = 500; // reset backoff after a clean open
        // Re-subscribe to every channel the renderer registered before
        // disconnect. New ws, same subscribers.
        for (const channel of state.subscribers.keys()) {
          ws.send(JSON.stringify({ kind: 'sub', channel }));
        }
        resolveReady();
      });
    });
    ws.addEventListener('message', (ev) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ServerFrame;
      } catch {
        return;
      }
      if (frame.kind === 'rpc-result') {
        const p = state.pending.get(frame.id);
        if (p) {
          state.pending.delete(frame.id);
          p.resolve(frame.result);
        }
      } else if (frame.kind === 'rpc-error') {
        const p = state.pending.get(frame.id);
        if (p) {
          state.pending.delete(frame.id);
          p.reject(new Error(frame.error));
        }
      } else if (frame.kind === 'event') {
        state.subscribers.get(frame.channel)?.forEach((cb) => cb(frame.payload));
      }
    });
    ws.addEventListener('close', () => {
      // Reject every in-flight RPC so callers see a real error rather
      // than a hang. Reconnect with exponential backoff.
      for (const p of state.pending.values()) p.reject(new Error('transport closed'));
      state.pending.clear();
      const wait = state.nextBackoffMs;
      state.nextBackoffMs = Math.min(state.nextBackoffMs * 2, 30_000);
      setTimeout(connect, wait);
    });
    ws.addEventListener('error', () => {
      // Force a close so the close handler's reconnect logic runs once.
      ws.close();
    });
  };

  connect();
  return state;
}

let stateRef: TransportState | null = null;

function getState(): TransportState {
  if (!stateRef) stateRef = createTransport();
  return stateRef;
}

async function rpc<T>(channel: string, payload: unknown): Promise<T> {
  const state = getState();
  await state.ready;
  if (!state.ws || state.ws.readyState !== state.ws.OPEN) {
    throw new Error('transport not connected');
  }
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return new Promise<T>((resolve, reject) => {
    state.pending.set(id, {
      resolve: (v) => resolve(v as T),
      reject,
    });
    state.ws!.send(JSON.stringify({ kind: 'rpc', id, channel, payload }));
  });
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const state = getState();
  let subs = state.subscribers.get(channel);
  if (!subs) {
    subs = new Set();
    state.subscribers.set(channel, subs);
    // First subscriber for this channel: send a `sub` frame. Idempotent
    // server-side, so re-subscribes after reconnect are safe.
    void state.ready.then(() => {
      if (state.ws && state.ws.readyState === state.ws.OPEN) {
        state.ws.send(JSON.stringify({ kind: 'sub', channel }));
      }
    });
  }
  const wrapper = (p: unknown) => cb(p as T);
  subs.add(wrapper);
  return () => {
    subs!.delete(wrapper);
    if (subs!.size === 0) {
      state.subscribers.delete(channel);
      if (state.ws && state.ws.readyState === state.ws.OPEN) {
        state.ws.send(JSON.stringify({ kind: 'unsub', channel }));
      }
    }
  };
}

/**
 * Build the same `window.vdxIpc` shape the Electron preload exposes,
 * backed by the WebSocket transport. Called once from main.tsx when
 * preload didn't run (browser context).
 */
export function installBrowserIpcPolyfill(): void {
  if (typeof window === 'undefined') return;
  if ('vdxIpc' in window && (window as Window & { vdxIpc?: unknown }).vdxIpc) return;

  const ipcApi = {
    appsList: () => rpc<AppsListResT>(IpcChannels.appsList, undefined),
    pickVdxpkg: () =>
      rpc<{ canceled: boolean; filePaths?: string[] }>(IpcChannels.pickVdxpkg, undefined),
    sideloadOpen: (vdxpkgPath: string) =>
      rpc<SideloadOpenResT>(IpcChannels.sideloadOpen, { vdxpkgPath }),
    installRun: (req: InstallRunReqT) => rpc<InstallRunResT>(IpcChannels.installRun, req),
    uninstallRun: (req: UninstallRunReqT) => rpc<UninstallRunResT>(IpcChannels.uninstallRun, req),
    catalogFetch: (req: CatalogFetchReqT) => rpc<CatalogFetchResT>(IpcChannels.catalogFetch, req),
    catalogInstall: (req: CatalogInstallReqT) =>
      rpc<CatalogInstallResT>(IpcChannels.catalogInstall, req),
    settingsGet: (req?: SettingsGetReqT) =>
      rpc<SettingsGetResT>(IpcChannels.settingsGet, req ?? {}),
    settingsSet: (req: SettingsSetReqT) => rpc<SettingsSetResT>(IpcChannels.settingsSet, req),
    diagExport: () => rpc<DiagExportResT>(IpcChannels.diagExport, {}),
    diagOpenLogs: () => rpc<DiagOpenLogsResT>(IpcChannels.diagOpenLogs, {}),
    updateCheck: () => rpc<UpdateCheckResT>(IpcChannels.updateCheck, {}),
    updateRun: () => rpc<UpdateRunResT>(IpcChannels.updateRun, { confirm: true }),
    updateApply: () => rpc<UpdateApplyResT>(IpcChannels.updateApply, { confirm: true }),
    onUpdateAvailable: (cb: (info: UpdateAvailableEventT) => void) =>
      subscribe(IpcChannels.updateAvailable, cb),
    appsCheckUpdates: () => rpc<AppsCheckUpdatesResT>(IpcChannels.appsCheckUpdates, {}),
    appsUpdateRun: (req: AppsUpdateRunReqT) =>
      rpc<AppsUpdateRunResT>(IpcChannels.appsUpdateRun, req),
    onAppsUpdatesAvailable: (cb: (ev: AppsUpdatesAvailableEventT) => void) =>
      subscribe(IpcChannels.appsUpdatesAvailable, cb),
    hostSetAutoLaunch: (req: HostSetAutoLaunchReqT) =>
      rpc<HostSetAutoLaunchResT>(IpcChannels.hostSetAutoLaunch, req),
    hostGetAutoLaunch: () => rpc<HostGetAutoLaunchResT>(IpcChannels.hostGetAutoLaunch, {}),
    authSetToken: (req: AuthSetTokenReqT) =>
      rpc<AuthSetTokenResT>(IpcChannels.authSetToken, req),
    authClearToken: () => rpc<AuthClearTokenResT>(IpcChannels.authClearToken, {}),
    onProgress: (cb: (ev: ProgressEventT) => void) => subscribe(IpcChannels.installProgress, cb),
  };

  (window as Window & { vdxIpc: typeof ipcApi }).vdxIpc = ipcApi;
}
