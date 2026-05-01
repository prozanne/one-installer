import type { IFs } from 'memfs';
import * as nodeFs from 'node:fs';
import { atomicWriteJson, readJsonOrDefault } from './atomic-write';
import { InstalledStateSchema, type InstalledStateT } from '@shared/schema';

type FsLike = IFs | typeof nodeFs;

export interface InstalledStore {
  read(): Promise<InstalledStateT>;
  update(mut: (s: InstalledStateT) => void): Promise<InstalledStateT>;
}

export function createInstalledStore(
  filePath: string,
  fs: FsLike,
  hostVersion: string,
): InstalledStore {
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

  const store: InstalledStore = {
    async read() {
      const raw = await readJsonOrDefault(filePath, defaults, fs);
      return InstalledStateSchema.parse(raw);
    },
    async update(mut) {
      const cur = await store.read();
      mut(cur);
      const validated = InstalledStateSchema.parse(cur);
      await atomicWriteJson(filePath, validated, fs);
      return validated;
    },
  };
  return store;
}
