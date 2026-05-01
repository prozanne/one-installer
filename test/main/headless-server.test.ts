/**
 * Headless server tests. Drive end-to-end against a real loopback HTTP
 * server + a real WebSocket client (the `ws` lib doubles as a Node
 * client). No mocking — we want real bytes on the wire because that's
 * where security gates either work or don't.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import {
  isHeadlessMode,
  resolveHeadlessBind,
  resolveHeadlessPort,
  startHeadlessServer,
  type HeadlessServerHandle,
  type IpcBridge,
} from '@main/headless-server';

let rendererDir: string;
let server: HeadlessServerHandle | null = null;

function makeRendererDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'vdx-renderer-'));
  writeFileSync(join(d, 'index.html'), '<!doctype html><body>OK</body>');
  mkdirSync(join(d, 'assets'), { recursive: true });
  writeFileSync(join(d, 'assets', 'app.js'), 'console.log("hi");');
  return d;
}

function makeBridge(opts: {
  invoke?: (channel: string, payload: unknown) => Promise<unknown>;
}): IpcBridge & { emit: (channel: string, payload: unknown) => void } {
  const subs = new Map<string, Set<(p: unknown) => void>>();
  return {
    invoke: opts.invoke ?? (async () => ({ ok: true })),
    subscribe(channel, cb) {
      let s = subs.get(channel);
      if (!s) {
        s = new Set();
        subs.set(channel, s);
      }
      s.add(cb);
      return () => {
        s!.delete(cb);
        if (s!.size === 0) subs.delete(channel);
      };
    },
    emit(channel, payload) {
      subs.get(channel)?.forEach((cb) => cb(payload));
    },
  };
}

async function freePort(): Promise<number> {
  // Bind to port 0, read assigned, close. Avoids fixed-port collisions
  // when the suite runs in parallel with other tests.
  const { createServer } = await import('node:http');
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const a = s.address();
      const p = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(p));
    });
  });
}

beforeEach(() => {
  rendererDir = makeRendererDir();
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
  rmSync(rendererDir, { recursive: true, force: true });
});

describe('startHeadlessServer — HTTP', () => {
  it('serves index.html with a valid token', async () => {
    const port = await freePort();
    server = startHeadlessServer({
      port,
      rendererDir,
      bridge: makeBridge({}),
      token: 'test-token',
    });
    const res = await fetch(`http://127.0.0.1:${port}/?token=test-token`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('OK');
  });

  it('rejects requests without a token (401)', async () => {
    const port = await freePort();
    server = startHeadlessServer({
      port,
      rendererDir,
      bridge: makeBridge({}),
      token: 'test-token',
    });
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(401);
  });

  it('rejects wrong tokens (constant-time compare)', async () => {
    const port = await freePort();
    server = startHeadlessServer({
      port,
      rendererDir,
      bridge: makeBridge({}),
      token: 'right',
    });
    const res = await fetch(`http://127.0.0.1:${port}/?token=wrong`);
    expect(res.status).toBe(401);
  });

  it('accepts the X-VDX-Token header alternative to query param', async () => {
    const port = await freePort();
    server = startHeadlessServer({
      port,
      rendererDir,
      bridge: makeBridge({}),
      token: 'test-token',
    });
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { 'x-vdx-token': 'test-token' },
    });
    expect(res.status).toBe(200);
  });

  it('serves nested asset paths', async () => {
    const port = await freePort();
    server = startHeadlessServer({
      port,
      rendererDir,
      bridge: makeBridge({}),
      token: 't',
    });
    const res = await fetch(`http://127.0.0.1:${port}/assets/app.js?token=t`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('console.log');
  });

  it('refuses path-traversal attempts (403)', async () => {
    const port = await freePort();
    server = startHeadlessServer({
      port,
      rendererDir,
      bridge: makeBridge({}),
      token: 't',
    });
    const res = await fetch(
      `http://127.0.0.1:${port}/${encodeURIComponent('../../../etc/passwd')}?token=t`,
    );
    expect(res.status).toBe(403);
  });

  it('falls back to index.html for SPA routing', async () => {
    const port = await freePort();
    server = startHeadlessServer({
      port,
      rendererDir,
      bridge: makeBridge({}),
      token: 't',
    });
    const res = await fetch(`http://127.0.0.1:${port}/agents?token=t`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('OK');
  });

  it('publicUrl carries the token', async () => {
    const port = await freePort();
    server = startHeadlessServer({
      port,
      rendererDir,
      bridge: makeBridge({}),
      token: 'abc',
    });
    expect(server.publicUrl).toContain(`http://127.0.0.1:${port}/?token=abc`);
  });
});

describe('startHeadlessServer — WebSocket bridge', () => {
  it('rejects WebSocket upgrade without a token', async () => {
    const port = await freePort();
    server = startHeadlessServer({
      port,
      rendererDir,
      bridge: makeBridge({}),
      token: 'tok',
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    await new Promise<void>((resolve, reject) => {
      ws.once('error', () => resolve());
      ws.once('open', () => reject(new Error('connection should have been refused')));
      setTimeout(resolve, 1000);
    });
    expect(ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING).toBe(true);
  });

  it('round-trips an RPC call', async () => {
    const port = await freePort();
    const bridge = makeBridge({
      invoke: async (channel, payload) => {
        if (channel === 'echo') return { received: payload };
        return null;
      },
    });
    server = startHeadlessServer({ port, rendererDir, bridge, token: 'tok' });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=tok`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ kind: 'rpc', id: '1', channel: 'echo', payload: { hello: 'world' } }));
    const msg = await new Promise<string>((resolve) =>
      ws.once('message', (data) => resolve(data.toString())),
    );
    const parsed = JSON.parse(msg) as { kind: string; id: string; result: { received: unknown } };
    expect(parsed.kind).toBe('rpc-result');
    expect(parsed.id).toBe('1');
    expect(parsed.result).toEqual({ received: { hello: 'world' } });
    ws.close();
  });

  it('reports rpc-error when the handler throws', async () => {
    const port = await freePort();
    const bridge = makeBridge({
      invoke: async () => {
        throw new Error('handler boom');
      },
    });
    server = startHeadlessServer({ port, rendererDir, bridge, token: 't' });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=t`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ kind: 'rpc', id: '1', channel: 'fail', payload: null }));
    const msg = await new Promise<string>((resolve) =>
      ws.once('message', (data) => resolve(data.toString())),
    );
    const parsed = JSON.parse(msg) as { kind: string; error: string };
    expect(parsed.kind).toBe('rpc-error');
    expect(parsed.error).toMatch(/handler boom/);
    ws.close();
  });

  it('forwards subscription events to the client', async () => {
    const port = await freePort();
    const bridge = makeBridge({});
    server = startHeadlessServer({ port, rendererDir, bridge, token: 't' });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=t`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ kind: 'sub', channel: 'progress' }));
    // Give the server a tick to register the subscriber.
    await new Promise((r) => setTimeout(r, 30));
    bridge.emit('progress', { percent: 42 });
    const msg = await new Promise<string>((resolve) =>
      ws.once('message', (data) => resolve(data.toString())),
    );
    const parsed = JSON.parse(msg) as { kind: string; channel: string; payload: { percent: number } };
    expect(parsed.kind).toBe('event');
    expect(parsed.channel).toBe('progress');
    expect(parsed.payload.percent).toBe(42);
    ws.close();
  });

  it('cleans up subscriptions on disconnect (no leak)', async () => {
    const port = await freePort();
    let unsubCalled = false;
    const bridge: IpcBridge = {
      invoke: async () => null,
      subscribe(_channel, _cb) {
        return () => {
          unsubCalled = true;
        };
      },
    };
    server = startHeadlessServer({ port, rendererDir, bridge, token: 't' });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=t`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ kind: 'sub', channel: 'x' }));
    await new Promise((r) => setTimeout(r, 30));
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(unsubCalled).toBe(true);
  });
});

describe('CLI flag helpers', () => {
  it('isHeadlessMode detects --headless', () => {
    expect(isHeadlessMode(['node', 'app.js'])).toBe(false);
    expect(isHeadlessMode(['node', 'app.js', '--headless'])).toBe(true);
  });

  it('resolveHeadlessPort honors --port and falls back to 8765', () => {
    expect(resolveHeadlessPort(['node', 'app.js'])).toBe(8765);
    expect(resolveHeadlessPort(['node', 'app.js', '--port', '9999'])).toBe(9999);
    // Out-of-range / non-numeric falls back to the default.
    expect(resolveHeadlessPort(['node', 'app.js', '--port', '999999'])).toBe(8765);
    expect(resolveHeadlessPort(['node', 'app.js', '--port', 'abc'])).toBe(8765);
  });

  it('resolveHeadlessBind honors --bind and rejects bad inputs', () => {
    expect(resolveHeadlessBind(['node'])).toBe('127.0.0.1');
    expect(resolveHeadlessBind(['node', '--bind', '0.0.0.0'])).toBe('0.0.0.0');
    expect(resolveHeadlessBind(['node', '--bind', 'localhost'])).toBe('localhost');
    // Hostname-looking input rejected — only IP-shaped strings pass the
    // best-effort regex (a deliberate limitation; users who need a
    // hostname can resolve to its IP and pass that).
    expect(resolveHeadlessBind(['node', '--bind', 'evil.example.com'])).toBe('127.0.0.1');
  });
});
