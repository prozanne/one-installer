import type { VdxIpcApi } from '../preload/index';

declare global {
  interface Window {
    vdxIpc: VdxIpcApi;
  }
}

export {};
