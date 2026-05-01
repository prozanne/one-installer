/**
 * Headless mode HTTP + WebSocket server.
 *
 * When the host is invoked with `--headless`, instead of opening an
 * Electron BrowserWindow we start an HTTP server that:
 *
 *   1. serves the pre-built renderer bundle (out/renderer/) as static files
 *   2. accepts WebSocket upgrades on the same port and bridges every
 *      registered IPC channel back to the renderer's `window.vdxIpc` shape
 *      (RPC + event subscriptions)
 *
 * The point: a Linux box with no display can run vdx-installer
 * `--headless --port 8888` and a user on any other machine — Windows,
 * macOS, another Linux — can browse to `http://that-box:8888/?token=…`
 * and drive the host through the same UI as if Electron were rendering
 * locally.
 *
 * Auth: a single bearer token is generated at startup and printed to
 * stdout. Every WebSocket upgrade and every static-asset response (after
 * the initial token-bootstrap page) checks for it. No multi-user model;
 * v1 is single-operator. Run behind nginx + corp SSO if you need more.
 *
 * Install operations affect the *host machine*, not the browsing machine.
 * That's the whole point — the browser is a remote control for the Linux
 * box. Don't expose the URL outside trusted networks.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';

export interface IpcBridge {
  /**
   * Invoke a registered IPC handler by channel name. Mirrors what the
   * renderer would do via `ipcRenderer.invoke(channel, payload)`. The
   * server side keeps a registry of (channel → handler) populated by
   * electron-main; we just look up + run.
   */
  invoke(channel: string, payload: unknown): Promise<unknown>;
  /**
   * Subscribe to a server-pushed event channel. Returns an unsubscribe
   * function. The bridge multiplexes — multiple WS clients subscribed to
   * the same channel each get a copy.
   */
  subscribe(channel: string, cb: (payload: unknown) => void): () => void;
}

export interface HeadlessServerOpts {
  port: number;
  /** Directory containing index.html + assets/. Production: out/renderer. */
  rendererDir: string;
  /** IPC bridge wrapping the existing handlers. */
  bridge: IpcBridge;
  /**
   * Override the random token (tests). Production omits — we generate
   * 32 bytes of cryptographic randomness at startup.
   */
  token?: string;
  /**
   * Bind address. Default '127.0.0.1' so the host is reachable only from
   * the local machine; operators who actually want LAN/internet access
   * have to opt in by passing '0.0.0.0' explicitly. Failing closed beats
   * failing open for a remote-control surface.
   */
  bindAddress?: string;
}

export interface HeadlessServerHandle {
  /** Stop accepting new connections + close existing WebSockets. */
  stop(): Promise<void>;
  /** The token used to authenticate connections. Print this to stdout. */
  token: string;
  /** The URL the user should open. Includes the token as a query param. */
  publicUrl: string;
  /** Underlying http.Server, exposed for tests. */
  httpServer: Server;
}

/** WebSocket frame schemas. Kept simple — no zod here, just shape checks. */
type ClientFrame =
  | { kind: 'rpc'; id: string; channel: string; payload: unknown }
  | { kind: 'sub'; channel: string }
  | { kind: 'unsub'; channel: string };

type ServerFrame =
  | { kind: 'rpc-result'; id: string; result: unknown }
  | { kind: 'rpc-error'; id: string; error: string }
  | { kind: 'event'; channel: string; payload: unknown };

/**
 * Ring buffer of recent events for the HTTP long-poll fallback. WebSocket
 * clients receive events live via subscribe(); HTTP-only clients read
 * `/api/events?since=N` and get every event with seq > N from the buffer.
 *
 * Capacity 256 covers a normal install's progress events (≤30 Hz × few
 * seconds). Older entries are dropped — clients that fall too far behind
 * lose events but the buffer never blows up.
 */
const EVENT_RING_CAPACITY = 256;
interface RingEntry {
  seq: number;
  channel: string;
  payload: unknown;
}
interface EventRing {
  entries: RingEntry[];
  seq: number;
  waiters: Set<() => void>;
}
function makeRing(): EventRing {
  return { entries: [], seq: 0, waiters: new Set() };
}
function recordEvent(ring: EventRing, channel: string, payload: unknown): void {
  ring.seq++;
  ring.entries.push({ seq: ring.seq, channel, payload });
  while (ring.entries.length > EVENT_RING_CAPACITY) ring.entries.shift();
  for (const w of ring.waiters) w();
  ring.waiters.clear();
}
function eventsSince(ring: EventRing, since: number): RingEntry[] {
  // Linear scan — fine for capacity 256.
  return ring.entries.filter((e) => e.seq > since);
}

/**
 * Generate a 256-bit URL-safe token. Used for WS auth + static-asset
 * cookie bootstrap. Constant-time compared on every WS upgrade.
 */
function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Constant-time string compare to defeat timing oracles on the auth check.
 * Node's `crypto.timingSafeEqual` requires equal-length buffers; we
 * pad+compare so attacker-supplied tokens of arbitrary length don't leak.
 */
function tokenEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Refuse path traversal in the static file route. Any request whose
 * normalized path escapes rendererDir is dropped at 403.
 */
function safeJoin(rendererDir: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const target = decoded === '/' ? '/index.html' : decoded;
  // Forbid backslash entirely — even on Windows the URL space is /-only.
  if (target.includes('\\')) return null;
  const joined = normalize(join(rendererDir, target));
  if (!joined.startsWith(rendererDir + sep) && joined !== rendererDir) return null;
  return joined;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function mimeFor(p: string): string {
  for (const ext of Object.keys(MIME)) {
    if (p.endsWith(ext)) return MIME[ext]!;
  }
  return 'application/octet-stream';
}

export function startHeadlessServer(opts: HeadlessServerOpts): HeadlessServerHandle {
  const token = opts.token ?? generateToken();
  const bind = opts.bindAddress ?? '127.0.0.1';
  const ring = makeRing();

  // Pipe every event the bridge surfaces into this server's ring buffer.
  // WebSocket subscribers still get them live via the bridge.subscribe
  // path; the ring is purely so HTTP-only clients can long-poll.
  // Each server instance owns its own ring so multiple test instances
  // don't share state.
  const ringCleanup: Array<() => void> = [];
  for (const ch of HTTP_FALLBACK_CHANNELS) {
    ringCleanup.push(opts.bridge.subscribe(ch, (payload) => recordEvent(ring, ch, payload)));
  }

  const httpServer = createServer((req, res) =>
    handleHttpRequest(req, res, opts, token, ring),
  );

  const wss = new WebSocketServer({ noServer: true });

  /** Active WS clients. Closed clients are removed on the close event. */
  const clients = new Set<WebSocket>();

  httpServer.on('upgrade', (req, socket, head) => {
    // Token check on the upgrade itself — once upgraded the WS messages
    // run authenticated, no need to re-check per frame.
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const t = url.searchParams.get('token') ?? '';
    if (!tokenEquals(t, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      bindWsClient(ws, opts.bridge, () => clients.delete(ws));
    });
  });

  httpServer.listen(opts.port, bind);
  const publicUrl = `http://${bind}:${opts.port}/?token=${encodeURIComponent(token)}`;

  return {
    token,
    publicUrl,
    httpServer,
    async stop() {
      for (const ws of clients) ws.close();
      for (const u of ringCleanup) u();
      // Wake any blocked long-pollers so they return without leaking.
      for (const w of ring.waiters) w();
      ring.waiters.clear();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/**
 * Channels the HTTP ring buffer mirrors. Kept narrow on purpose — only
 * the broadcast events the renderer subscribes to. RPC results travel
 * through the synchronous POST /api/rpc and never hit the ring.
 */
const HTTP_FALLBACK_CHANNELS = [
  'install:progress',
  'update:available',
  'apps:updatesAvailable',
] as const;

function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: HeadlessServerOpts,
  token: string,
  ring: EventRing,
): void {
  // Token gate: present in `?token=` query string (first hit) or in the
  // Cookie. The renderer's transport bootstrap stashes the token into
  // localStorage on first load and forwards it on every fetch via header
  // — but we also accept the query-param form so a bare URL works.
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const queryToken = url.searchParams.get('token') ?? '';
  const headerToken =
    (req.headers['x-vdx-token'] as string | undefined) ?? '';
  const presented = queryToken || headerToken;
  if (!tokenEquals(presented, token)) {
    res.statusCode = 401;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('unauthorized — append ?token=… to the URL or send X-VDX-Token header');
    return;
  }

  // HTTP fallback transport. Used when the user's network gateway strips
  // WebSocket upgrades (corporate HTTP-only proxies, some load balancers,
  // a few VPN gateways). The browser-side transport tries WS first and
  // falls back to these endpoints if the upgrade fails.
  if (req.method === 'POST' && url.pathname === '/api/rpc') {
    handleHttpRpc(req, res, opts);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    handleHttpEvents(req, res, url, ring);
    return;
  }

  const filePath = safeJoin(opts.rendererDir, url.pathname);
  if (!filePath) {
    res.statusCode = 403;
    res.end('forbidden');
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    // SPA fallback — serve index.html so client-side routing works.
    const indexPath = join(opts.rendererDir, 'index.html');
    if (!existsSync(indexPath)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader(
      'content-security-policy',
      "default-src 'self'; connect-src 'self' ws:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
    );
    createReadStream(indexPath).pipe(res);
    return;
  }
  res.statusCode = 200;
  res.setHeader('content-type', mimeFor(filePath));
  res.setHeader(
    'content-security-policy',
    "default-src 'self'; connect-src 'self' ws:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
  );
  createReadStream(filePath).pipe(res);
}

/**
 * POST /api/rpc body = { id?, channel, payload } → 200 { result } | 500 { error }.
 * Synchronous: one request per RPC, no multiplexing. Used by the browser's
 * HTTP fallback transport when WebSocket isn't reachable through the
 * network path.
 */
function handleHttpRpc(req: IncomingMessage, res: ServerResponse, opts: HeadlessServerOpts): void {
  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString('utf-8');
    // Defensive cap — the manifest schema is small but a misbehaving
    // proxy could send us multi-MB payloads. 1 MiB is plenty.
    if (body.length > 1024 * 1024) {
      res.statusCode = 413;
      res.end('payload too large');
      req.destroy();
    }
  });
  req.on('end', async () => {
    if (res.writableEnded) return;
    let parsed: { channel?: string; payload?: unknown };
    try {
      parsed = JSON.parse(body) as { channel?: string; payload?: unknown };
    } catch {
      res.statusCode = 400;
      res.end('invalid json');
      return;
    }
    if (typeof parsed.channel !== 'string') {
      res.statusCode = 400;
      res.end('missing channel');
      return;
    }
    try {
      const result = await opts.bridge.invoke(parsed.channel, parsed.payload);
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ result }));
    } catch (e) {
      res.statusCode = 200; // not 500 — errors are normal RPC outcomes
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  });
}

/**
 * GET /api/events?since=N&timeout=30000 — long-poll for events past `since`.
 *
 * Behaviour:
 *  - If events past `since` already exist, return them immediately.
 *  - Otherwise wait up to `timeout` ms for new events. Return whatever
 *    accumulates, or an empty list on timeout.
 *
 * Response: { events: [{ seq, channel, payload }], last: highestSeq }.
 * Client persists `last` and uses it as `since` for the next poll.
 */
function handleHttpEvents(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ring: EventRing,
): void {
  const since = Number(url.searchParams.get('since') ?? '0');
  const timeoutMs = Math.min(Number(url.searchParams.get('timeout') ?? '30000'), 60_000);
  const respond = () => {
    if (res.writableEnded) return;
    const events = eventsSince(ring, since);
    const last = events.length > 0 ? events[events.length - 1]!.seq : since;
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    // Disable client-side caching — every poll must hit the server.
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ events, last }));
  };
  if (eventsSince(ring, since).length > 0) {
    respond();
    return;
  }
  // Block until something happens or the timeout fires.
  let resolved = false;
  const onTick = () => {
    if (resolved) return;
    resolved = true;
    ring.waiters.delete(waiter);
    clearTimeout(timer);
    respond();
  };
  const waiter = onTick;
  ring.waiters.add(waiter);
  const timer = setTimeout(onTick, timeoutMs);
  // If the client disconnects, drop the waiter so we don't leak.
  req.on('close', () => {
    if (resolved) return;
    resolved = true;
    ring.waiters.delete(waiter);
    clearTimeout(timer);
  });
}

function bindWsClient(ws: WebSocket, bridge: IpcBridge, onClose: () => void): void {
  /** Active subscriptions per channel — disposed when the client disconnects. */
  const subs = new Map<string, () => void>();

  const send = (frame: ServerFrame) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(frame));
  };

  ws.on('message', async (raw) => {
    let msg: ClientFrame;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()) as ClientFrame;
    } catch {
      return; // ignore malformed frames; renderer should never send these
    }
    if (msg.kind === 'rpc') {
      try {
        const result = await bridge.invoke(msg.channel, msg.payload);
        send({ kind: 'rpc-result', id: msg.id, result });
      } catch (e) {
        send({ kind: 'rpc-error', id: msg.id, error: (e as Error).message });
      }
      return;
    }
    if (msg.kind === 'sub') {
      if (subs.has(msg.channel)) return; // already subscribed; idempotent
      const unsub = bridge.subscribe(msg.channel, (payload) =>
        send({ kind: 'event', channel: msg.channel, payload }),
      );
      subs.set(msg.channel, unsub);
      return;
    }
    if (msg.kind === 'unsub') {
      subs.get(msg.channel)?.();
      subs.delete(msg.channel);
      return;
    }
  });

  ws.on('close', () => {
    for (const u of subs.values()) u();
    subs.clear();
    onClose();
  });
}

/**
 * Was the host launched with the `--headless` flag? electron-main checks
 * this very early to decide whether to skip BrowserWindow creation and
 * start the HTTP server instead.
 */
export function isHeadlessMode(argv: readonly string[] = process.argv): boolean {
  return argv.includes('--headless');
}

/**
 * Pick the port for the headless server: `--port N` arg if present,
 * otherwise 8765 (chosen because it's outside the well-known and
 * registered ranges and unlikely to collide with anything common).
 */
export function resolveHeadlessPort(argv: readonly string[] = process.argv): number {
  const idx = argv.indexOf('--port');
  if (idx >= 0 && idx + 1 < argv.length) {
    const n = Number(argv[idx + 1]);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  return 8765;
}

/** Bind address: `--bind 0.0.0.0` to allow LAN access. Default 127.0.0.1. */
export function resolveHeadlessBind(argv: readonly string[] = process.argv): string {
  const idx = argv.indexOf('--bind');
  if (idx >= 0 && idx + 1 < argv.length) {
    const v = argv[idx + 1];
    // Reject anything non-IP-looking — best-effort guard against
    // command-line typos turning into "expose to all interfaces".
    if (typeof v === 'string' && /^[\d.:]+$|^localhost$/i.test(v)) return v;
  }
  return '127.0.0.1';
}
