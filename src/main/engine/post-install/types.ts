import type { Platform } from '@main/platform';
import type { PostInstallActionT, JournalEntryT } from '@shared/schema';
import type { Context, SystemVars } from '@main/engine/template';

export interface ActionContext {
  platform: Platform;
  templateContext: Context;
  systemVars: SystemVars;
  installPath: string;
  appId: string;
  payloadDir: string;
}

export interface ActionHandler<T extends PostInstallActionT['type']> {
  type: T;
  apply(
    action: Extract<PostInstallActionT, { type: T }>,
    ctx: ActionContext,
  ): Promise<JournalEntryT>;
  inverse(entry: JournalEntryT, platform: Platform): Promise<void>;
}
