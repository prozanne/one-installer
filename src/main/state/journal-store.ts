import type { IFs } from 'memfs';
import * as nodeFs from 'node:fs';
import { TransactionFile, type TransactionFileT } from '@shared/schema';

type FsLike = IFs | typeof nodeFs;

export interface JournalStore {
  write(txid: string, tx: TransactionFileT): Promise<void>;
  read(txid: string): Promise<TransactionFileT | null>;
  list(): Promise<string[]>;
  delete(txid: string): Promise<void>;
}

export function createJournalStore(dir: string, fs: FsLike = nodeFs): JournalStore {
  const fsP = (fs as IFs).promises;

  return {
    async write(txid, tx) {
      await fsP.mkdir(dir, { recursive: true });
      const tmp = `${dir}/${txid}.json.tmp`;
      await fsP.writeFile(tmp, JSON.stringify(tx, null, 2));
      await fsP.rename(tmp, `${dir}/${txid}.json`);
    },
    async read(txid) {
      try {
        const buf = await fsP.readFile(`${dir}/${txid}.json`);
        const obj = JSON.parse(buf.toString());
        return TransactionFile.parse(obj);
      } catch {
        return null;
      }
    },
    async list() {
      try {
        const entries = (await fsP.readdir(dir)) as unknown as string[];
        return entries.filter((e) => e.endsWith('.json')).map((e) => e.slice(0, -5));
      } catch {
        return [];
      }
    },
    async delete(txid) {
      try {
        await fsP.unlink(`${dir}/${txid}.json`);
      } catch {
        /* ignore */
      }
    },
  };
}
