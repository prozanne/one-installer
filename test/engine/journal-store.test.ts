import { describe, it, expect } from 'vitest';
import { createJournalStore } from '@main/state/journal-store';
import { MockPlatform } from '@main/platform';

describe('journal-store', () => {
  it('writes, lists, and reads journal files', async () => {
    const p = new MockPlatform();
    const store = createJournalStore('/journal', p.fs);
    const txid = '00000000-0000-4000-8000-000000000001';
    await store.write(txid, {
      txid,
      appId: 'com.samsung.vdx.x',
      version: '1.0.0',
      scope: 'user',
      status: 'pending',
      startedAt: new Date().toISOString(),
      endedAt: null,
      steps: [],
    });
    expect(await store.list()).toEqual([txid]);
    const loaded = await store.read(txid);
    expect(loaded?.appId).toBe('com.samsung.vdx.x');
  });

  it('deletes', async () => {
    const p = new MockPlatform();
    const store = createJournalStore('/journal', p.fs);
    const txid = '00000000-0000-4000-8000-000000000002';
    await store.write(txid, {
      txid,
      appId: 'x',
      version: '1.0.0',
      scope: 'user',
      status: 'committed',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      steps: [],
    });
    await store.delete(txid);
    expect(await store.list()).toEqual([]);
  });
});
