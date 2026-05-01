import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IpcChannels } from '@shared/ipc-types';
import type {
  AppsListResT,
  SideloadOpenResT,
  InstallRunReqT,
  InstallRunResT,
  UninstallRunReqT,
  UninstallRunResT,
  ProgressEventT,
  CatalogFetchReqT,
  CatalogFetchResT,
  CatalogInstallReqT,
  CatalogInstallResT,
  SettingsGetReqT,
  SettingsGetResT,
  SettingsSetReqT,
  SettingsSetResT,
  DiagExportResT,
  DiagOpenLogsResT,
  UpdateApplyResT,
  UpdateAvailableEventT,
  UpdateCheckResT,
  UpdateRunResT,
  AuthSetTokenReqT,
  AuthSetTokenResT,
  AuthClearTokenResT,
} from '@shared/ipc-types';

const ipcApi = {
  async appsList(): Promise<AppsListResT> {
    return ipcRenderer.invoke(IpcChannels.appsList);
  },
  async pickVdxpkg(): Promise<{ canceled: boolean; filePaths?: string[] }> {
    return ipcRenderer.invoke(IpcChannels.pickVdxpkg);
  },
  async sideloadOpen(vdxpkgPath: string): Promise<SideloadOpenResT> {
    return ipcRenderer.invoke(IpcChannels.sideloadOpen, { vdxpkgPath });
  },
  async installRun(req: InstallRunReqT): Promise<InstallRunResT> {
    return ipcRenderer.invoke(IpcChannels.installRun, req);
  },
  async uninstallRun(req: UninstallRunReqT): Promise<UninstallRunResT> {
    return ipcRenderer.invoke(IpcChannels.uninstallRun, req);
  },
  async catalogFetch(req: CatalogFetchReqT): Promise<CatalogFetchResT> {
    return ipcRenderer.invoke(IpcChannels.catalogFetch, req);
  },
  async catalogInstall(req: CatalogInstallReqT): Promise<CatalogInstallResT> {
    return ipcRenderer.invoke(IpcChannels.catalogInstall, req);
  },
  async settingsGet(req?: SettingsGetReqT): Promise<SettingsGetResT> {
    return ipcRenderer.invoke(IpcChannels.settingsGet, req ?? {});
  },
  async settingsSet(req: SettingsSetReqT): Promise<SettingsSetResT> {
    return ipcRenderer.invoke(IpcChannels.settingsSet, req);
  },
  async diagExport(): Promise<DiagExportResT> {
    return ipcRenderer.invoke(IpcChannels.diagExport, {});
  },
  async diagOpenLogs(): Promise<DiagOpenLogsResT> {
    // No payload: the renderer can never name a directory to open. Main
    // always opens its own logs dir. (Critique Rule 10.)
    return ipcRenderer.invoke(IpcChannels.diagOpenLogs, {});
  },
  async updateCheck(): Promise<UpdateCheckResT> {
    return ipcRenderer.invoke(IpcChannels.updateCheck, {});
  },
  async updateRun(): Promise<UpdateRunResT> {
    return ipcRenderer.invoke(IpcChannels.updateRun, { confirm: true });
  },
  async updateApply(): Promise<UpdateApplyResT> {
    return ipcRenderer.invoke(IpcChannels.updateApply, { confirm: true });
  },
  /**
   * Subscribe to background `update:available` broadcasts. Main fires this
   * exactly once per *new* version it discovers — repeat polls of the same
   * version do not re-broadcast. Returns an unsubscribe function so the
   * renderer can detach on unmount.
   */
  onUpdateAvailable(cb: (info: UpdateAvailableEventT) => void): () => void {
    const listener = (_e: IpcRendererEvent, payload: UpdateAvailableEventT) => cb(payload);
    ipcRenderer.on(IpcChannels.updateAvailable, listener);
    return () => ipcRenderer.removeListener(IpcChannels.updateAvailable, listener);
  },
  async authSetToken(req: AuthSetTokenReqT): Promise<AuthSetTokenResT> {
    return ipcRenderer.invoke(IpcChannels.authSetToken, req);
  },
  async authClearToken(): Promise<AuthClearTokenResT> {
    return ipcRenderer.invoke(IpcChannels.authClearToken, {});
  },
  onProgress(cb: (ev: ProgressEventT) => void): () => void {
    const listener = (_e: IpcRendererEvent, payload: ProgressEventT) => cb(payload);
    ipcRenderer.on(IpcChannels.installProgress, listener);
    return () => ipcRenderer.removeListener(IpcChannels.installProgress, listener);
  },
};

contextBridge.exposeInMainWorld('vdxIpc', ipcApi);

export type VdxIpcApi = typeof ipcApi;
