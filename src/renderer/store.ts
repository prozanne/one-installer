import { create } from 'zustand';
import type { CatalogT, Manifest } from '@shared/schema';
import type { AppsListResT, ProgressEventT } from '@shared/ipc-types';

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
