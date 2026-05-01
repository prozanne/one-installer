/**
 * applyHostUpdate tests.
 *
 * Stubs out the platform branch + spawn so the suite runs identically on
 * macOS / Linux CI / Windows. The Authenticode verify path is a Windows-only
 * shellout we cannot exercise here — it is gated by `verifyAuthenticode:
 * false` and exercised manually in the Phase 1.2 smoke checklist.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyHostUpdate } from '@main/updater/apply';

function makeStagedFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vdx-apply-'));
  const path = join(dir, 'vdx-installer-9.9.9.staged');
  // 4 KiB of zeros — bigger than the 1 KiB sanity floor.
  writeFileSync(path, Buffer.alloc(4096));
  return path;
}

describe('applyHostUpdate', () => {
  it('refuses on non-win32 platforms', async () => {
    const stagedPath = makeStagedFile();
    try {
      const res = await applyHostUpdate({
        stagedPath,
        onQuit: () => {},
        platform: 'darwin',
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('unsupported-platform');
    } finally {
      rmSync(stagedPath, { force: true });
    }
  });

  it('refuses when the staged file is missing', async () => {
    const res = await applyHostUpdate({
      stagedPath: '/does/not/exist.staged',
      onQuit: () => {},
      platform: 'win32',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('missing-staged');
  });

  it('refuses a staged file under the 1 KiB sanity floor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vdx-apply-'));
    const path = join(dir, 'tiny.staged');
    writeFileSync(path, Buffer.alloc(100));
    try {
      const res = await applyHostUpdate({
        stagedPath: path,
        onQuit: () => {},
        platform: 'win32',
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('missing-staged');
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('on win32 with verify=false: spawns the staged installer + calls onQuit', async () => {
    const stagedPath = makeStagedFile();
    const onQuit = vi.fn();
    const fakeChild = { unref: vi.fn() } as unknown as ReturnType<typeof import('node:child_process').spawn>;
    const spawnFn = vi.fn().mockReturnValue(fakeChild);
    try {
      const res = await applyHostUpdate({
        stagedPath,
        onQuit,
        platform: 'win32',
        verifyAuthenticode: false,
        spawnFn: spawnFn as never,
      });
      expect(res.ok).toBe(true);
      expect(spawnFn).toHaveBeenCalledTimes(1);
      const [cmd, args, options] = spawnFn.mock.calls[0]!;
      expect(cmd).toBe(stagedPath);
      expect(args).toEqual(['/S', '--updated']);
      expect(options).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true });
      expect(fakeChild.unref).toHaveBeenCalledTimes(1);
      expect(onQuit).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(stagedPath, { force: true });
    }
  });

  it('reports spawn-failed cleanly when the child cannot be created', async () => {
    const stagedPath = makeStagedFile();
    const onQuit = vi.fn();
    const spawnFn = vi.fn().mockImplementation(() => {
      throw new Error('CreateProcess failed: ENOENT');
    });
    try {
      const res = await applyHostUpdate({
        stagedPath,
        onQuit,
        platform: 'win32',
        verifyAuthenticode: false,
        spawnFn: spawnFn as never,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('spawn-failed');
      // Critical: do NOT quit if we never got the spawn off. Otherwise the
      // host exits and the user is left with no installer at all.
      expect(onQuit).not.toHaveBeenCalled();
    } finally {
      rmSync(stagedPath, { force: true });
    }
  });
});
