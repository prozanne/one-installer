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
  HostInfoResT,
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
  /**
   * 'ws' = primary path (WebSocket connected and healthy).
   * 'http' = HTTP-only fallback (corporate proxy / load balancer stripped
   *   the WS upgrade). RPCs go through POST /api/rpc, events through a
   *   long-poll loop on GET /api/events.
   * 'connecting' = trying WS for the first time; queued RPCs wait on
   *   `ready`.
   */
  mode: 'connecting' | 'ws' | 'http';
  ws: WebSocket | null;
  /** Resolved when the transport is usable (either WS open or HTTP picked). */
  ready: Promise<void>;
  pending: Map<string, Pending>;
  subscribers: Map<string, Set<(payload: unknown) => void>>;
  /** Backoff in ms for the next reconnect; doubles up to 30s. */
  nextBackoffMs: number;
  /** HTTP long-poll: highest event seq we've already seen. */
  lastEventSeq: number;
  /** HTTP long-poll: AbortController so we can stop the loop on tear-down. */
  pollAbort: AbortController | null;
}

/**
 * sessionStorage key recording that WebSocket failed once for this
 * session. We persist the choice so reloads / route changes don't
 * re-attempt WS — the corporate proxy that stripped the upgrade once
 * will keep stripping it.
 */
const WS_FAILED_KEY = 'vdx.transport.wsFailed';

function createTransport(): TransportState {
  const state: TransportState = {
    mode: 'connecting',
    ws: null,
    ready: Promise.resolve(),
    pending: new Map(),
    subscribers: new Map(),
    nextBackoffMs: 500,
    lastEventSeq: 0,
    pollAbort: null,
  };

  const switchToHttpFallback = () => {
    if (state.mode === 'http') return;
    state.mode = 'http';
    try {
      sessionStorage.setItem(WS_FAILED_KEY, '1');
    } catch {
      /* ignore */
    }
    startEventPolling(state);
  };

  const connectWs = () => {
    const token = readToken();
    if (!token) return;

    // If WS already failed this session, don't bother retrying.
    let wsAlreadyFailed = false;
    try {
      wsAlreadyFailed = sessionStorage.getItem(WS_FAILED_KEY) === '1';
    } catch {
      /* ignore */
    }
    if (wsAlreadyFailed) {
      switchToHttpFallback();
      return;
    }

    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${wsProto}//${window.location.host}/?token=${encodeURIComponent(token)}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      switchToHttpFallback();
      return;
    }
    state.ws = ws;

    // 5-second handshake watchdog. If the proxy is going to strip the
    // upgrade and never reply, we'd hang forever otherwise. WHATWG WS
    // doesn't expose a timeout option, so we wrap one ourselves.
    const handshakeTimeout = setTimeout(() => {
      if (state.mode !== 'connecting') return;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      switchToHttpFallback();
    }, 5_000);

    state.ready = new Promise<void>((resolveReady) => {
      ws.addEventListener('open', () => {
        clearTimeout(handshakeTimeout);
        state.mode = 'ws';
        state.nextBackoffMs = 500;
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
      clearTimeout(handshakeTimeout);
      // If we never reached 'ws' mode, the upgrade was stripped — fall back.
      if (state.mode === 'connecting') {
        switchToHttpFallback();
        return;
      }
      // We were healthy; treat this as a transient drop and reconnect.
      for (const p of state.pending.values()) p.reject(new Error('transport closed'));
      state.pending.clear();
      const wait = state.nextBackoffMs;
      state.nextBackoffMs = Math.min(state.nextBackoffMs * 2, 30_000);
      setTimeout(connectWs, wait);
    });
    ws.addEventListener('error', () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  };

  connectWs();
  return state;
}

/**
 * HTTP long-poll loop for events. Started once on switchToHttpFallback
 * and runs until the page unloads or pollAbort is signalled.
 */
function startEventPolling(state: TransportState): void {
  state.pollAbort?.abort();
  state.pollAbort = new AbortController();
  const signal = state.pollAbort.signal;

  const tick = async (): Promise<void> => {
    if (signal.aborted) return;
    const token = readToken();
    if (!token) return;
    try {
      const url = `/api/events?since=${state.lastEventSeq}&timeout=25000`;
      const res = await fetch(url, {
        headers: { 'x-vdx-token': token },
        signal,
      });
      if (!res.ok) {
        // 401 means token rotated — we can't recover without a new URL.
        // Backoff and retry; the user will eventually re-launch and
        // get a fresh token in the new URL.
        await new Promise((r) => setTimeout(r, 5_000));
        return tick();
      }
      const body = (await res.json()) as {
        events: { seq: number; channel: string; payload: unknown }[];
        last: number;
      };
      for (const ev of body.events) {
        state.subscribers.get(ev.channel)?.forEach((cb) => cb(ev.payload));
      }
      state.lastEventSeq = Math.max(state.lastEventSeq, body.last);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      // Network blip — short backoff and retry. We never give up; the
      // user is staring at a UI that needs progress events.
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return tick();
  };
  void tick();
}

let stateRef: TransportState | null = null;

function getState(): TransportState {
  if (!stateRef) stateRef = createTransport();
  return stateRef;
}

async function rpc<T>(channel: string, payload: unknown): Promise<T> {
  const state = getState();
  await state.ready;
  if (state.mode === 'http') {
    return rpcHttp<T>(channel, payload);
  }
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

/**
 * HTTP-only RPC. Synchronous: one POST per call, await the response
 * body. Auth via X-VDX-Token header. Errors arrive as `{ error: string }`
 * in the body (status is still 200) so we don't leak handler error
 * details into HTTP response codes that might surface in proxy access logs.
 */
async function rpcHttp<T>(channel: string, payload: unknown): Promise<T> {
  const token = readToken();
  if (!token) throw new Error('no token — open the URL printed by --headless');
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-vdx-token': token,
    },
    body: JSON.stringify({ channel, payload }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { result?: T; error?: string };
  if (body.error) throw new Error(body.error);
  return body.result as T;
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const state = getState();
  let subs = state.subscribers.get(channel);
  if (!subs) {
    subs = new Set();
    state.subscribers.set(channel, subs);
    // WS path: send a `sub` frame so the server starts forwarding events.
    // HTTP path: nothing to do — long-poll is global, all channels arrive,
    // and we filter on this side via the subscribers map.
    void state.ready.then(() => {
      if (state.mode === 'ws' && state.ws && state.ws.readyState === state.ws.OPEN) {
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
      if (state.mode === 'ws' && state.ws && state.ws.readyState === state.ws.OPEN) {
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
    hostInfo: () => rpc<HostInfoResT>(IpcChannels.hostInfo, {}),
    authSetToken: (req: AuthSetTokenReqT) =>
      rpc<AuthSetTokenResT>(IpcChannels.authSetToken, req),
    authClearToken: () => rpc<AuthClearTokenResT>(IpcChannels.authClearToken, {}),
    onProgress: (cb: (ev: ProgressEventT) => void) => subscribe(IpcChannels.installProgress, cb),
  };

  (window as Window & { vdxIpc: typeof ipcApi }).vdxIpc = ipcApi;
}
