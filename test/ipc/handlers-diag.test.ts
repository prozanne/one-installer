/**
 * Diagnostic IPC handler tests.
 *
 * Targets the pure functions in `src/main/ipc/handlers/diag.ts`. Uses real
 * tmpdirs (the handler talks to node:fs / yazl directly) and a vi.fn shell
 * so we can assert what path the handler tried to surface to the OS.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleDiagExport, handleDiagOpenLogs } from '@main/ipc/handlers/diag';
import type { DiagShell } from '@main/ipc/handlers/diag';

let cacheDir: string;
let logsDir: string;
let shell: DiagShell & {
  showItemInFolder: ReturnType<typeof vi.fn>;
  openPath: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  const root = join(tmpdir(), `vdx-diag-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  cacheDir = join(root, 'cache');
  logsDir = join(root, 'logs');
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  shell = {
    showItemInFolder: vi.fn(),
    openPath: vi.fn().mockResolvedValue(''),
  };
});

afterEach(() => {
  // Best effort — ignore failures on Windows-style locked files.
  try {
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(logsDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('diag:export handler', () => {
  it('writes a zip archive containing all .log + .ndjson files', async () => {
    writeFileSync(join(logsDir, 'app.log'), 'hello world');
    writeFileSync(join(logsDir, 'events.ndjson'), '{"k":"v"}\n');
    writeFileSync(join(logsDir, 'random.txt'), 'should be skipped');

    const res = await handleDiagExport(
      { paths: { cacheDir, logsDir }, shell, now: () => 1234567890 },
      {},
    );
    expect(res.ok).toBe(true);
    expect(shell.showItemInFolder).toHaveBeenCalledTimes(1);
    const archivePath = shell.showItemInFolder.mock.calls[0]?.[0] as string;
    expect(archivePath).toBe(join(cacheDir, 'vdx-diag-1234567890.zip'));
    expect(existsSync(archivePath)).toBe(true);
    // Non-empty archive — yazl writes a trailing central directory even for
    // an empty input set, so a few hundred bytes is plausible. The two log
    // files we added should push the size well above the empty baseline.
    expect(statSync(archivePath).size).toBeGreaterThan(50);
  });

  it('still succeeds when logsDir has no log files (empty archive)', async () => {
    writeFileSync(join(logsDir, 'noise.txt'), 'unrelated');
    const res = await handleDiagExport(
      { paths: { cacheDir, logsDir }, shell, now: () => 1 },
      {},
    );
    expect(res.ok).toBe(true);
    expect(shell.showItemInFolder).toHaveBeenCalledTimes(1);
  });

  it('still succeeds when logsDir does not exist (readdir throws, swallowed)', async () => {
    rmSync(logsDir, { recursive: true, force: true });
    const res = await handleDiagExport(
      { paths: { cacheDir, logsDir }, shell, now: () => 1 },
      {},
    );
    expect(res.ok).toBe(true);
  });

  it('rejects malformed input via zod', async () => {
    const res = await handleDiagExport(
      { paths: { cacheDir, logsDir }, shell },
      'not-an-object',
    );
    expect(res.ok).toBe(false);
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it('returns ok:false when cacheDir is unwritable (no archive surfaced)', async () => {
    // Point at a path inside a nonexistent parent so createWriteStream errors.
    const res = await handleDiagExport(
      { paths: { cacheDir: '/this/path/should/not/exist/anywhere', logsDir }, shell, now: () => 1 },
      {},
    );
    expect(res.ok).toBe(false);
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });
});

describe('diag:openLogs handler', () => {
  it('opens the logs directory via shell', async () => {
    const res = await handleDiagOpenLogs({ paths: { cacheDir, logsDir }, shell }, {});
    expect(res.ok).toBe(true);
    expect(shell.openPath).toHaveBeenCalledWith(logsDir);
  });

  it('forwards shell.openPath errors as ok:false', async () => {
    shell.openPath = vi.fn().mockRejectedValue(new Error('shell denied'));
    const res = await handleDiagOpenLogs({ paths: { cacheDir, logsDir }, shell }, {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('shell denied');
  });

  it('rejects malformed input via zod', async () => {
    const res = await handleDiagOpenLogs(
      { paths: { cacheDir, logsDir }, shell },
      'not-an-object',
    );
    expect(res.ok).toBe(false);
    expect(shell.openPath).not.toHaveBeenCalled();
  });
});
