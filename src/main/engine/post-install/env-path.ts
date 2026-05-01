import { renderTemplate } from '@main/engine/template';
import type { ActionHandler } from './types';
import type { JournalEntryT } from '@shared/schema';

export const envPathHandler: ActionHandler<'envPath'> = {
  type: 'envPath',
  async apply(action, ctx) {
    const dir = renderTemplate(action.add, ctx.templateContext, ctx.systemVars);
    await ctx.platform.pathEnvAdd(action.scope, dir);
    const entry: JournalEntryT = {
      type: 'envPath',
      scope: action.scope,
      added: dir,
      atTs: new Date().toISOString(),
    };
    return entry;
  },
  async inverse(entry, platform) {
    if (entry.type !== 'envPath') return;
    try {
      await platform.pathEnvRemove(entry.scope, entry.added);
    } catch {
      /* idempotent */
    }
  },
};
