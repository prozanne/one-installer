import { describe, it, expect } from 'vitest';
import { createTransactionRunner } from '@main/engine/transaction';
import { createJournalStore } from '@main/state/journal-store';
import { MockPlatform } from '@main/platform';

describe('TransactionRunner', () => {
  it('commits a successful transaction', async () => {
    const p = new MockPlatform();
    const journal = createJournalStore('/journal', p.fs);
    const runner = createTransactionRunner({ journal });
    const tx = await runner.begin({ appId: 'x', version: '1.0.0', scope: 'user' });
    await tx.append({ type: 'extract', files: ['a.txt'], atTs: new Date().toISOString() });
    await tx.commit();
    expect(await journal.list()).toEqual([]);
  });

  it('rolls back on error by replaying inverses', async () => {
    const p = new MockPlatform();
    const journal = createJournalStore('/journal', p.fs);
    const inverses: string[] = [];
    const runner = createTransactionRunner({
      journal,
      inverseHandler: async (entry) => {
        inverses.push(entry.type);
      },
    });
    const tx = await runner.begin({ appId: 'x', version: '1.0.0', scope: 'user' });
    await tx.append({ type: 'extract', files: ['a.txt'], atTs: new Date().toISOString() });
    await tx.append({
      type: 'shortcut',
      path: '/Desktop/x.lnk',
      atTs: new Date().toISOString(),
    });
    await tx.rollback('test failure');
    expect(inverses).toEqual(['shortcut', 'extract']);
    expect(await journal.list()).toEqual([]);
  });

  it('recoverPending returns non-committed transactions', async () => {
    const p = new MockPlatform();
    const journal = createJournalStore('/journal', p.fs);
    const runner = createTransactionRunner({ journal });
    const tx = await runner.begin({ appId: 'x', version: '1.0.0', scope: 'user' });
    await tx.append({ type: 'extract', files: [], atTs: new Date().toISOString() });
    // Do not commit — simulate crash
    const pending = await runner.recoverPending();
    expect(pending.length).toBe(1);
    expect(pending[0]!.status).toBe('pending');
  });
});
