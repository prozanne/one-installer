import { renderTemplate } from '@main/engine/template';
import type { ActionHandler } from './types';
import type { JournalEntryT } from '@shared/schema';
import { posix as path } from 'node:path';

export const execHandler: ActionHandler<'exec'> = {
  type: 'exec',
  async apply(action, ctx) {
    const cmd = renderTemplate(action.cmd, ctx.templateContext, ctx.systemVars);
    const args = action.args.map((a) => renderTemplate(a, ctx.templateContext, ctx.systemVars));
    if (!path.isAbsolute(cmd)) throw new Error(`exec cmd must be absolute: ${cmd}`);
    if (!cmd.startsWith(ctx.installPath) && !cmd.startsWith(ctx.payloadDir)) {
      throw new Error(`exec cmd must reside inside installPath or payloadDir: ${cmd}`);
    }
    const hash = await ctx.platform.fileSha256(cmd);
    const allowed = new Set(action.allowedHashes.map((h) => h.replace(/^sha256:/, '')));
    if (!allowed.has(hash)) {
      throw new Error(`exec binary hash mismatch (${hash}) — not in allowedHashes`);
    }
    const result = await ctx.platform.exec({
      cmd,
      args,
      cwd: ctx.installPath,
      timeoutMs: action.timeoutSec * 1000,
    });
    if (result.timedOut) throw new Error(`exec timed out after ${action.timeoutSec}s`);
    if (result.exitCode !== 0) throw new Error(`exec exit code ${result.exitCode}`);
    const entry: JournalEntryT = {
      type: 'exec',
      cmd,
      exitCode: result.exitCode,
      atTs: new Date().toISOString(),
    };
    return entry;
  },
  async inverse() {
    // exec is non-reversible by design (see spec §7.4).
  },
};
