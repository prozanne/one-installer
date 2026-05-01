/**
 * Pure settings IPC handlers — extracted from `electron-main.ts` so each can
 * be unit-tested without booting the Electron lifecycle.
 *
 * Each handler is `(deps, raw) => Promise<Res>`; the binding to `ipcMain.handle`
 * lives in `register-handlers.ts` (or inline in `main()` for now).
 */
import {
  SettingsGetReq,
  SettingsSetReq,
  type SettingsGetResT,
  type SettingsSetResT,
} from '@shared/ipc-types';
import type { InstalledStore } from '@main/state/installed-store';

export interface SettingsHandlerDeps {
  installedStore: InstalledStore;
}

export async function handleSettingsGet(
  deps: SettingsHandlerDeps,
  raw: unknown,
): Promise<SettingsGetResT> {
  const parsed = SettingsGetReq.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, error: 'invalid request' };
  try {
    const state = await deps.installedStore.read();
    return { ok: true, settings: state.settings };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function handleSettingsSet(
  deps: SettingsHandlerDeps,
  raw: unknown,
): Promise<SettingsSetResT> {
  const parsed = SettingsSetReq.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'invalid request' };
  try {
    const updated = await deps.installedStore.update((s) => {
      Object.assign(s.settings, parsed.data.patch);
    });
    return { ok: true, settings: updated.settings };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
