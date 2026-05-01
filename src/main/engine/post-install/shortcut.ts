import { renderTemplate } from '@main/engine/template';
import type { ActionHandler } from './types';

export const shortcutHandler: ActionHandler<'shortcut'> = {
  type: 'shortcut',
  async apply(action, ctx) {
    const target = renderTemplate(action.target, ctx.templateContext, ctx.systemVars);
    let dir: string;
    switch (action.where) {
      case 'desktop':
        dir = ctx.systemVars.Desktop!;
        break;
      case 'startMenu':
        dir = ctx.systemVars.StartMenu!;
        break;
      case 'programs':
        dir = `${ctx.systemVars.StartMenu}/${ctx.appId}`;
        break;
    }
    await ctx.platform.ensureDir(dir);
    const lnkPath = `${dir}/${action.name}.lnk`;
    await ctx.platform.createShortcut({
      path: lnkPath,
      target,
      args: action.args,
      workingDir: ctx.installPath,
      description: action.name,
    });
    return { type: 'shortcut', path: lnkPath, atTs: new Date().toISOString() };
  },
  async inverse(entry, platform) {
    if (entry.type !== 'shortcut') return;
    try {
      await platform.deleteShortcut(entry.path);
    } catch {
      /* idempotent */
    }
  },
};
