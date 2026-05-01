import type { IFs } from 'memfs';
import type * as nodeFs from 'node:fs';
import { atomicWriteJson, readJsonWithBakFallback, type ReadStatus } from './atomic-write';
import { InstalledStateSchema, type InstalledStateT } from '@shared/schema';

type FsLike = IFs | typeof nodeFs;

export interface InstalledStore {
  read(): Promise<InstalledStateT>;
  update(mut: (s: InstalledStateT) => void): Promise<InstalledStateT>;
  /** Last read source — useful for telemetry / diagnostics that want to log when .bak was used. */
  lastReadStatus(): ReadStatus | null;
}

export function createInstalledStore(
  filePath: string,
  fs: FsLike,
  hostVersion: string,
): InstalledStore {
  const bakPath = `${filePath}.bak`;
  const defaults = (): InstalledStateT => ({
    schema: 1,
    host: { version: hostVersion },
    lastCatalogSync: null,
    settings: {
      language: 'en',
      updateChannel: 'stable',
      autoUpdateHost: 'ask',
      autoUpdateApps: 'ask',
      cacheLimitGb: 5,
      proxy: null,
      telemetry: false,
      trayMode: false,
      developerMode: false,
    },
    apps: {},
  });

  let lastStatus: ReadStatus | null = null;

  // Promise queue serialising `update()` so two concurrent callers can't
  // race read → mutate → write and lose one mutation. Each new update is
  // chained onto the previous one's settled state. `read()` stays free to
  // run in parallel — it doesn't mutate.
  let updateQueue: Promise<unknown> = Promise.resolve();

  const store: InstalledStore = {
    async read() {
      const { value, status } = await readJsonWithBakFallback<unknown>(
        filePath,
        bakPath,
        defaults,
        fs,
      );
      lastStatus = status;
      // If the primary parsed but is schema-invalid, try .bak before giving up.
      const primary = InstalledStateSchema.safeParse(value);
      if (primary.success) return primary.data;
      if (status === 'bak' || status === 'default') {
        // Already on a fallback path; surface schema error so caller knows state is gone.
        return InstalledStateSchema.parse(defaults());
      }
      try {
        const bakBuf = await (fs as IFs).promises.readFile(bakPath);
        const bakParsed = InstalledStateSchema.safeParse(JSON.parse(bakBuf.toString()));
        if (bakParsed.success) {
          lastStatus = 'bak';
          return bakParsed.data;
        }
      } catch {
        /* fall through */
      }
      lastStatus = 'default';
      return InstalledStateSchema.parse(defaults());
    },
    update(mut) {
      // Queue this update behind any in-flight one. We always read fresh
      // disk state inside the chained closure so we never operate on a
      // stale baseline from a sibling update that hasn't finished yet.
      const next = updateQueue.then(async () => {
        const cur = await store.read();
        mut(cur);
        const validated = InstalledStateSchema.parse(cur);
        await atomicWriteJson(filePath, validated, fs);
        return validated;
      });
      // Swallow any rejection on the queue chain itself so a single failing
      // update doesn't poison every subsequent caller. The error still
      // propagates to *this* caller via the returned promise.
      updateQueue = next.catch(() => undefined);
      return next;
    },
    lastReadStatus() {
      return lastStatus;
    },
  };
  return store;
}
