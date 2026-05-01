import { describe, it, expect } from 'vitest';
import { acquireAppLock } from '@main/state/lock';
import { MockPlatform } from '@main/platform';

describe('acquireAppLock', () => {
  it('returns release on first acquire, errors on second', async () => {
    const p = new MockPlatform();
    await p.ensureDir('/locks');
    const r1 = await acquireAppLock('/locks', 'app1', p.fs);
    expect(r1.ok).toBe(true);
    const r2 = await acquireAppLock('/locks', 'app1', p.fs);
    expect(r2.ok).toBe(false);
    if (r1.ok) await r1.value.release();
    const r3 = await acquireAppLock('/locks', 'app1', p.fs);
    expect(r3.ok).toBe(true);
    if (r3.ok) await r3.value.release();
  });

  it('recovers a stale lock whose PID is no longer alive', async () => {
    const p = new MockPlatform({ livePids: [] }); // PID 9999 is dead
    await p.ensureDir('/locks');
    await p.fs.promises.writeFile(
      '/locks/app1.lock',
      `pid=9999\nat=2026-01-01T00:00:00.000Z\n`,
    );
    const recovered: { path: string; staleBody: string }[] = [];
    const r = await acquireAppLock('/locks', 'app1', p.fs, {
      isPidAlive: (pid) => p.isPidAlive(pid),
      onStaleLockRecovered: (info) => recovered.push(info),
    });
    expect(r.ok).toBe(true);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.staleBody).toContain('pid=9999');
    if (r.ok) await r.value.release();
  });

  it('refuses acquisition when the recorded PID is alive', async () => {
    const p = new MockPlatform({ livePids: [4321] });
    await p.ensureDir('/locks');
    await p.fs.promises.writeFile(
      '/locks/app1.lock',
      `pid=4321\nat=2026-01-01T00:00:00.000Z\n`,
    );
    const r = await acquireAppLock('/locks', 'app1', p.fs, {
      isPidAlive: (pid) => p.isPidAlive(pid),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/busy/i);
  });

  it('treats a malformed lockfile as stale and reclaims it', async () => {
    const p = new MockPlatform();
    await p.ensureDir('/locks');
    await p.fs.promises.writeFile('/locks/app1.lock', 'corrupted\n');
    const r = await acquireAppLock('/locks', 'app1', p.fs, {
      isPidAlive: () => Promise.resolve(true), // even with "alive", parse failure wins
    });
    expect(r.ok).toBe(true);
    if (r.ok) await r.value.release();
  });

  it('without isPidAlive callback, treats any existing lock as busy', async () => {
    const p = new MockPlatform({ livePids: [] });
    await p.ensureDir('/locks');
    await p.fs.promises.writeFile(
      '/locks/app1.lock',
      `pid=9999\nat=2026-01-01T00:00:00.000Z\n`,
    );
    const r = await acquireAppLock('/locks', 'app1', p.fs);
    expect(r.ok).toBe(false);
  });
});
