import { describe, it, expect } from 'vitest';
import { createTransactionRunner, orderedForRollback } from '@main/engine/transaction';
import { createJournalStore } from '@main/state/journal-store';
import { MockPlatform } from '@main/platform';
import type { JournalEntryT } from '@shared/schema';

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

  it('stamps stepOrdinal on each appended entry, increasing from 0', async () => {
    const p = new MockPlatform();
    const journal = createJournalStore('/journal', p.fs);
    const runner = createTransactionRunner({ journal });
    const tx = await runner.begin({ appId: 'x', version: '1.0.0', scope: 'user' });
    await tx.append({ type: 'extract', files: ['a'], atTs: new Date().toISOString() });
    await tx.append({
      type: 'shortcut',
      path: '/Desktop/x.lnk',
      atTs: new Date().toISOString(),
    });
    await tx.append({
      type: 'envPath',
      scope: 'user',
      added: '/p',
      atTs: new Date().toISOString(),
    });
    const committed = await tx.commit();
    expect(committed.steps.map((s) => s.stepOrdinal)).toEqual([0, 1, 2]);
  });

  it('rollback iterates by descending stepOrdinal even when steps array is shuffled', async () => {
    const p = new MockPlatform();
    const journal = createJournalStore('/journal', p.fs);
    const inverses: number[] = [];
    const runner = createTransactionRunner({
      journal,
      inverseHandler: async (entry) => {
        inverses.push(entry.stepOrdinal ?? -1);
      },
    });
    const tx = await runner.begin({ appId: 'x', version: '1.0.0', scope: 'user' });
    await tx.append({ type: 'extract', files: ['a'], atTs: new Date().toISOString() });
    await tx.append({
      type: 'shortcut',
      path: '/Desktop/x.lnk',
      atTs: new Date().toISOString(),
    });
    await tx.append({
      type: 'envPath',
      scope: 'user',
      added: '/p',
      atTs: new Date().toISOString(),
    });
    // Externally tamper with the on-disk journal: shuffle steps array.
    const fname = `/journal/${tx.txid}.json`;
    const raw = JSON.parse((await p.fs.promises.readFile(fname)).toString());
    raw.steps = [raw.steps[2], raw.steps[0], raw.steps[1]]; // shuffled
    await p.fs.promises.writeFile(fname, JSON.stringify(raw));
    // Reload via journal store to pick up the tampered file, then create a
    // fresh tx-bound runner that hands rollback the shuffled file.
    const tampered = await journal.read(tx.txid);
    expect(tampered).not.toBeNull();
    const ordered = orderedForRollback(tampered!.steps);
    expect(ordered.map((e) => e.stepOrdinal)).toEqual([2, 1, 0]);
    // And via tx.rollback the inverse order is still descending:
    await tx.rollback('test');
    expect(inverses).toEqual([2, 1, 0]);
  });

  it('orderedForRollback falls back to array index when stepOrdinal absent', () => {
    const entries: JournalEntryT[] = [
      { type: 'extract', files: ['a'], atTs: '2026-01-01T00:00:00.000Z' },
      { type: 'shortcut', path: '/a.lnk', atTs: '2026-01-01T00:00:00.000Z' },
    ];
    const ordered = orderedForRollback(entries);
    expect(ordered.map((e) => e.type)).toEqual(['shortcut', 'extract']);
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
