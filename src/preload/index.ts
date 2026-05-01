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
  onProgress(cb: (ev: ProgressEventT) => void): () => void {
    const listener = (_e: IpcRendererEvent, payload: ProgressEventT) => cb(payload);
    ipcRenderer.on(IpcChannels.installProgress, listener);
    return () => ipcRenderer.removeListener(IpcChannels.installProgress, listener);
  },
};

contextBridge.exposeInMainWorld('vdxIpc', ipcApi);

export type VdxIpcApi = typeof ipcApi;
