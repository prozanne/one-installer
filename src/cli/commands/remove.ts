/**
 * `vdx remove <id>` — uninstall a previously installed app.
 *
 * Mirrors the `uninstall:run` IPC: read installed entry → run engine
 * uninstall → drop from installed.json. Sideloaded apps are uninstalled
 * the same way; the engine's uninstall pipeline is source-agnostic.
 */
import type { CliHost } from '../host-bootstrap';
import { c, clearStatus, confirmYn, println, status } from '../output';
import { runUninstall } from '@main/engine';

export interface RemoveOpts {
  appId: string;
  yes: boolean;
}

export async function cmdRemove(host: CliHost, opts: RemoveOpts): Promise<number> {
  const state = await host.installedStore.read();
  const entry = state.apps[opts.appId];
  if (!entry) {
    println(c.red(`Not installed: ${opts.appId}`));
    return 1;
  }
  if (!opts.yes) {
    const ok = await confirmYn(`Remove ${c.bold(opts.appId)} ${c.dim('v' + entry.version)}?`);
    if (!ok) {
      println(c.dim('Aborted.'));
      return 1;
    }
  }
  status(`Removing ${opts.appId}…`);
  const res = await runUninstall({
    manifest: entry.manifestSnapshot,
    installPath: entry.installPath,
    journalEntries: entry.journal,
    platform: host.platform,
    runner: host.runner,
    scope: entry.installScope,
    lockDir: host.paths.locksDir,
    wizardAnswers: entry.wizardAnswers,
  });
  clearStatus();
  if (!res.ok) {
    println(c.red(`Uninstall failed: ${res.error}`));
    return 1;
  }
  await host.installedStore.update((s) => {
    delete s.apps[opts.appId];
  });
  println(c.green(`✓ Removed ${opts.appId}`));
  return 0;
}
