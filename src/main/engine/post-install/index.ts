import type { PostInstallActionT, JournalEntryT } from '@shared/schema';
import { evaluateWhen } from '@main/engine/when-expr';
import { shortcutHandler } from './shortcut';
import { registryHandler } from './registry';
import { envPathHandler } from './env-path';
import { execHandler } from './exec';
import type { ActionContext } from './types';

export * from './types';
export { shortcutHandler } from './shortcut';
export { registryHandler } from './registry';
export { envPathHandler } from './env-path';
export { execHandler } from './exec';
export { arpRegister, arpDeregister } from './arp';

export async function applyAction(
  action: PostInstallActionT,
  ctx: ActionContext,
): Promise<JournalEntryT | null> {
  if (!evaluateWhen(action.when, ctx.templateContext)) return null;
  switch (action.type) {
    case 'shortcut':
      return shortcutHandler.apply(action, ctx);
    case 'registry':
      return registryHandler.apply(action, ctx);
    case 'envPath':
      return envPathHandler.apply(action, ctx);
    case 'exec':
      return execHandler.apply(action, ctx);
  }
}

export async function inverseAction(
  entry: JournalEntryT,
  platform: import('@main/platform').Platform,
): Promise<void> {
  switch (entry.type) {
    case 'shortcut':
      return shortcutHandler.inverse(entry, platform);
    case 'registry':
      return registryHandler.inverse(entry, platform);
    case 'envPath':
      return envPathHandler.inverse(entry, platform);
    case 'exec':
      return execHandler.inverse(entry, platform);
    case 'extract':
    case 'arp':
      // handled elsewhere
      return;
  }
}
