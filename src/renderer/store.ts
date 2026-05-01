import { create } from 'zustand';
import type { CatalogT, Manifest } from '@shared/schema';
import type {
  AppsListResT,
  AppUpdateCandidateT,
  ProgressEventT,
  UpdateAvailableEventT,
} from '@shared/ipc-types';

/**
 * Self-update lifecycle. The renderer transitions:
 *
 *   idle → available  (background poll fired or check returned non-null)
 *      → downloading  (user clicked the badge → updateRun)
 *      → ready        (download succeeded; show "Restart now")
 *      → applying     (user clicked Restart now → updateApply; main quits us)
 *      → idle         (failure paths — clear out and let next poll retry)
 *
 * `info` carries through the whole flow so the user sees the same version
 * label from announcement to restart.
 */
export type SelfUpdateState =
  | { phase: 'idle' }
  | { phase: 'available'; info: UpdateAvailableEventT }
  | { phase: 'downloading'; info: UpdateAvailableEventT }
  | { phase: 'ready'; info: UpdateAvailableEventT }
  | { phase: 'applying'; info: UpdateAvailableEventT }
  | { phase: 'error'; info: UpdateAvailableEventT | null; error: string };

export interface SideloadState {
  sessionId: string;
  manifest: Manifest;
  defaultInstallPath: string;
  signatureValid: boolean;
  /** Tags whether this session originated from sideload or a catalog tab. */
  kind: 'app' | 'agent';
}

export interface CatalogSlice {
  catalog: CatalogT | null;
  signatureValid: boolean | null;
  fetchedAt: string | null;
  sourceUrl: string | null;
  loading: boolean;
  error: string | null;
}

export interface UiState {
  apps: AppsListResT;
  loadingApps: boolean;
  sideload: SideloadState | null;
  wizardAnswers: Record<string, unknown>;
  progress: ProgressEventT | null;
  error: string | null;
  appCatalog: CatalogSlice;
  agentCatalog: CatalogSlice;
  selfUpdate: SelfUpdateState;
  setSelfUpdate: (s: SelfUpdateState) => void;
  runSelfUpdate: () => Promise<void>;
  applySelfUpdate: () => Promise<void>;
  /** Per-app update candidates surfaced via apps:checkUpdates / apps:updatesAvailable. */
  appUpdates: AppUpdateCandidateT[];
  setAppUpdates: (candidates: AppUpdateCandidateT[]) => void;
  refreshAppUpdates: () => Promise<void>;
  /** Trigger a single-app update; routes the renderer to the wizard with the new session. */
  runAppUpdate: (appId: string) => Promise<{ ok: boolean; error?: string }>;
  refreshApps: () => Promise<void>;
  startSideload: (vdxpkgPath: string) => Promise<{ ok: boolean; error?: string }>;
  refreshCatalog: (kind: 'app' | 'agent') => Promise<void>;
  installFromCatalog: (
    kind: 'app' | 'agent',
    appId: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  setAnswer: (id: string, value: unknown) => void;
  setAllAnswers: (answers: Record<string, unknown>) => void;
  resetWizard: () => void;
  setProgress: (ev: ProgressEventT) => void;
  setError: (msg: string | null) => void;
}

const emptyCatalog = (): CatalogSlice => ({
  catalog: null,
  signatureValid: null,
  fetchedAt: null,
  sourceUrl: null,
  loading: false,
  error: null,
});

export const useStore = create<UiState>()((set, get) => ({
  apps: {},
  loadingApps: false,
  sideload: null,
  wizardAnswers: {},
  progress: null,
  error: null,
  appCatalog: emptyCatalog(),
  agentCatalog: emptyCatalog(),
  selfUpdate: { phase: 'idle' },
  appUpdates: [],
  setAppUpdates(candidates) {
    set({ appUpdates: candidates });
  },
  async refreshAppUpdates() {
    const res = await window.vdxIpc.appsCheckUpdates();
    if (res.ok) set({ appUpdates: res.candidates });
  },
  async runAppUpdate(appId) {
    const res = await window.vdxIpc.appsUpdateRun({ appId });
    if (!res.ok) {
      set({ error: res.error });
      return { ok: false, error: res.error };
    }
    if (res.installed) {
      // Silent path completed (none today, since handler always returns
      // installed:false). Refresh installed apps + drop this candidate.
      await get().refreshApps();
      set({ appUpdates: get().appUpdates.filter((c) => c.appId !== appId) });
      return { ok: true };
    }
    if (!res.sessionId || !res.manifest || !res.defaultInstallPath) {
      const msg = 'Invalid response from apps:updateRun';
      set({ error: msg });
      return { ok: false, error: msg };
    }
    // Wizard path — drop into the same SideloadState the catalog flow uses.
    const candidate = get().appUpdates.find((c) => c.appId === appId);
    set({
      sideload: {
        sessionId: res.sessionId,
        manifest: res.manifest,
        defaultInstallPath: res.defaultInstallPath,
        signatureValid: res.signatureValid ?? false,
        kind: candidate?.kind ?? 'app',
      },
      wizardAnswers: { installPath: res.defaultInstallPath },
      progress: null,
      error: null,
    });
    return { ok: true };
  },
  setSelfUpdate(s) {
    set({ selfUpdate: s });
  },
  async runSelfUpdate() {
    const cur = get().selfUpdate;
    if (cur.phase !== 'available') return;
    set({ selfUpdate: { phase: 'downloading', info: cur.info } });
    const res = await window.vdxIpc.updateRun();
    if (res.ok) {
      set({ selfUpdate: { phase: 'ready', info: cur.info } });
    } else {
      set({ selfUpdate: { phase: 'error', info: cur.info, error: res.error } });
    }
  },
  async applySelfUpdate() {
    const cur = get().selfUpdate;
    if (cur.phase !== 'ready') return;
    set({ selfUpdate: { phase: 'applying', info: cur.info } });
    const res = await window.vdxIpc.updateApply();
    if (!res.ok) {
      // Apply failed — drop back to ready so the user can retry.
      set({ selfUpdate: { phase: 'error', info: cur.info, error: res.error } });
    }
    // On success the host is about to quit; nothing more to do here.
  },
  async refreshApps() {
    set({ loadingApps: true });
    try {
      const apps = await window.vdxIpc.appsList();
      set({ apps, loadingApps: false });
    } catch (e) {
      set({ loadingApps: false, error: (e as Error).message });
    }
  },
  async startSideload(vdxpkgPath) {
    const res = await window.vdxIpc.sideloadOpen(vdxpkgPath);
    if (!res.ok) {
      set({ error: res.error });
      return { ok: false, error: res.error };
    }
    const initialAnswers: Record<string, unknown> = {
      installPath: res.defaultInstallPath,
    };
    set({
      sideload: {
        sessionId: res.sessionId,
        manifest: res.manifest,
        defaultInstallPath: res.defaultInstallPath,
        signatureValid: res.signatureValid,
        kind: 'app',
      },
      wizardAnswers: initialAnswers,
      progress: null,
      error: null,
    });
    return { ok: true };
  },
  async refreshCatalog(kind) {
    const slice = kind === 'agent' ? 'agentCatalog' : 'appCatalog';
    set({ [slice]: { ...get()[slice], loading: true, error: null } } as Partial<UiState>);
    const res = await window.vdxIpc.catalogFetch({ kind });
    if (res.ok) {
      set({
        [slice]: {
          catalog: res.catalog,
          signatureValid: res.signatureValid,
          fetchedAt: res.fetchedAt,
          sourceUrl: res.sourceUrl,
          loading: false,
          error: null,
        },
      } as Partial<UiState>);
    } else {
      set({
        [slice]: {
          ...get()[slice],
          loading: false,
          error: res.error,
          sourceUrl: res.sourceUrl ?? null,
        },
      } as Partial<UiState>);
    }
  },
  async installFromCatalog(kind, appId) {
    const res = await window.vdxIpc.catalogInstall({ kind, appId });
    if (!res.ok) {
      set({ error: res.error });
      return { ok: false, error: res.error };
    }
    const initialAnswers: Record<string, unknown> = {
      installPath: res.defaultInstallPath,
    };
    set({
      sideload: {
        sessionId: res.sessionId,
        manifest: res.manifest,
        defaultInstallPath: res.defaultInstallPath,
        signatureValid: res.signatureValid,
        kind: res.kind,
      },
      wizardAnswers: initialAnswers,
      progress: null,
      error: null,
    });
    return { ok: true };
  },
  setAnswer(id, value) {
    set({ wizardAnswers: { ...get().wizardAnswers, [id]: value } });
  },
  setAllAnswers(answers) {
    set({ wizardAnswers: answers });
  },
  resetWizard() {
    set({ sideload: null, wizardAnswers: {}, progress: null, error: null });
  },
  setProgress(ev) {
    set({ progress: ev });
  },
  setError(msg) {
    set({ error: msg });
  },
}));
