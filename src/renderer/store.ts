import { create } from 'zustand';
import type { Manifest } from '@shared/schema';
import type { AppsListResT, ProgressEventT } from '@shared/ipc-types';

export interface SideloadState {
  sessionId: string;
  manifest: Manifest;
  defaultInstallPath: string;
  signatureValid: boolean;
}

export interface UiState {
  apps: AppsListResT;
  loadingApps: boolean;
  sideload: SideloadState | null;
  wizardAnswers: Record<string, unknown>;
  progress: ProgressEventT | null;
  error: string | null;
  refreshApps: () => Promise<void>;
  startSideload: (vdxpkgPath: string) => Promise<{ ok: boolean; error?: string }>;
  setAnswer: (id: string, value: unknown) => void;
  setAllAnswers: (answers: Record<string, unknown>) => void;
  resetWizard: () => void;
  setProgress: (ev: ProgressEventT) => void;
  setError: (msg: string | null) => void;
}

export const useStore = create<UiState>()((set, get) => ({
  apps: {},
  loadingApps: false,
  sideload: null,
  wizardAnswers: {},
  progress: null,
  error: null,
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
