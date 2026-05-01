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
});
