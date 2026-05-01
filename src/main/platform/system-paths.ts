import type { SystemVars } from '@main/engine/template';

export interface SystemPathsInput {
  programFiles: string;
  programFilesX86: string;
  localAppData: string;
  desktop: string;
  startMenu: string;
  temp: string;
  installerVersion: string;
  appId: string;
  appVersion: string;
}

export function buildSystemVars(input: SystemPathsInput): SystemVars {
  return {
    ProgramFiles: input.programFiles,
    ProgramFilesX86: input.programFilesX86,
    LocalAppData: input.localAppData,
    Desktop: input.desktop,
    StartMenu: input.startMenu,
    Temp: input.temp,
    InstallerVersion: input.installerVersion,
    AppId: input.appId,
    AppVersion: input.appVersion,
  };
}
