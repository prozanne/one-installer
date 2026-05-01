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
  DiagOpenLogsReqT,
  DiagOpenLogsResT,
  UpdateCheckResT,
  UpdateRunResT,
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
  async diagOpenLogs(req: DiagOpenLogsReqT): Promise<DiagOpenLogsResT> {
    return ipcRenderer.invoke(IpcChannels.diagOpenLogs, req);
  },
  async updateCheck(): Promise<UpdateCheckResT> {
    return ipcRenderer.invoke(IpcChannels.updateCheck, {});
  },
  async updateRun(): Promise<UpdateRunResT> {
    return ipcRenderer.invoke(IpcChannels.updateRun, { confirm: true });
  },
  onProgress(cb: (ev: ProgressEventT) => void): () => void {
    const listener = (_e: IpcRendererEvent, payload: ProgressEventT) => cb(payload);
    ipcRenderer.on(IpcChannels.installProgress, listener);
    return () => ipcRenderer.removeListener(IpcChannels.installProgress, listener);
  },
};

contextBridge.exposeInMainWorld('vdxIpc', ipcApi);

export type VdxIpcApi = typeof ipcApi;
