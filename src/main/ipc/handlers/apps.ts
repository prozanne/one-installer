/**
 * Pure apps:list handler — extracted from `electron-main.ts` so test
 * harnesses can call it directly with an injected installedStore.
 */
import type { AppsListResT } from '@shared/ipc-types';
import type { InstalledStore } from '@main/state/installed-store';

export interface AppsListDeps {
  installedStore: InstalledStore;
}

export async function handleAppsList(deps: AppsListDeps): Promise<AppsListResT> {
  const state = await deps.installedStore.read();
  return state.apps;
}
