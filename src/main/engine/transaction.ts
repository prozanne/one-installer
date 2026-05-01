import { randomUUID } from 'node:crypto';
import type { JournalEntryT, TransactionFileT } from '@shared/schema';
import type { JournalStore } from '@main/state/journal-store';

export type InverseHandler = (entry: JournalEntryT) => Promise<void>;

export interface TransactionRunner {
  begin(input: BeginInput): Promise<Transaction>;
  recoverPending(): Promise<TransactionFileT[]>;
}

export interface BeginInput {
  appId: string;
  version: string;
  scope: 'user' | 'machine';
  txid?: string;
}

export interface Transaction {
  readonly txid: string;
  append(entry: JournalEntryT): Promise<void>;
  commit(): Promise<TransactionFileT>;
  rollback(reason: string): Promise<void>;
}

export interface RunnerOptions {
  journal: JournalStore;
  inverseHandler?: InverseHandler;
  now?: () => Date;
}

export function createTransactionRunner(opts: RunnerOptions): TransactionRunner {
  const now = opts.now ?? (() => new Date());

  return {
    async begin(input) {
      const txid = input.txid ?? randomUUID();
      const file: TransactionFileT = {
        txid,
        appId: input.appId,
        version: input.version,
        scope: input.scope,
        status: 'pending',
        startedAt: now().toISOString(),
        endedAt: null,
        steps: [],
      };
      await opts.journal.write(txid, file);

      const tx: Transaction = {
        txid,
        async append(entry) {
          file.steps.push(entry);
          await opts.journal.write(txid, file);
        },
        async commit() {
          file.status = 'committed';
          file.endedAt = now().toISOString();
          await opts.journal.write(txid, file);
          await opts.journal.delete(txid);
          return file;
        },
        async rollback(reason) {
          for (const e of [...file.steps].reverse()) {
            try {
              if (opts.inverseHandler) await opts.inverseHandler(e);
            } catch {
              /* continue rolling back */
            }
          }
          file.status = 'rolled-back';
          file.endedAt = now().toISOString();
          await opts.journal.write(txid, file);
          await opts.journal.delete(txid);
          void reason;
        },
      };
      return tx;
    },

    async recoverPending() {
      const ids = await opts.journal.list();
      const out: TransactionFileT[] = [];
      for (const id of ids) {
        const t = await opts.journal.read(id);
        if (t && t.status !== 'committed' && t.status !== 'rolled-back') out.push(t);
      }
      return out;
    },
  };
}
