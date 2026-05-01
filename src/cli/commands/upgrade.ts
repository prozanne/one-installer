/**
 * `vdx upgrade [<id>] [--all]` — upgrade installed apps that have a newer
 * catalog entry. Mirrors `apps:checkUpdates` + `apps:updateRun` from the
 * IPC layer.
 *
 * Without args: prints the candidate list and exits — apt-style "show me
 * what would change". With `<id>`: upgrades that one. With `--all`:
 * upgrades every candidate.
 */
import type { CliHost } from '../host-bootstrap';
import { c, confirmYn, pad, println } from '../output';
import { fetchCatalogVerified } from '@main/catalog';
import { diffInstalledVsCatalog } from '@main/engine/diff-versions';
import { cmdInstall } from './install';

export interface UpgradeOpts {
  appId?: string;
  all: boolean;
  yes: boolean;
}

export async function cmdUpgrade(host: CliHost, opts: UpgradeOpts): Promise<number> {
  if (!host.packageSource) {
    println(c.red('No catalog source configured.'));
    return 1;
  }
  let catalogApps;
  try {
    const r = await fetchCatalogVerified(host.packageSource, { trustRoots: host.trustRoots });
    if ('notModified' in r) {
      println(c.dim('Catalog returned 304 but CLI has no cache.'));
      return 0;
    }
    catalogApps = r.catalog.apps;
  } catch (e) {
    println(c.red(`Catalog fetch failed: ${(e as Error).message}`));
    return 1;
  }

  const state = await host.installedStore.read();
  const installed = state.apps;
  const candidates = diffInstalledVsCatalog({
    installed,
    catalogItems: catalogApps,
    channel: state.settings.updateChannel,
  });

  if (candidates.length === 0) {
    println(c.dim('All apps are up to date.'));
    return 0;
  }

  // Filter to single id when requested.
  const targets = opts.appId
    ? candidates.filter((c) => c.appId === opts.appId)
    : opts.all
      ? candidates
      : candidates;

  if (opts.appId && targets.length === 0) {
    println(c.dim(`No upgrade available for ${opts.appId}.`));
    return 0;
  }

  // No-action mode: show candidates and exit.
  if (!opts.appId && !opts.all) {
    println(c.bold(pad('ID', 32) + pad('FROM', 14) + 'TO'));
    for (const cand of targets) {
      println(pad(cand.appId, 32) + pad(cand.fromVersion, 14) + cand.toVersion);
    }
    println('');
    println(
      c.dim(`Run ${c.bold('vdx upgrade --all')} to apply, or ${c.bold('vdx upgrade <id>')} for one.`),
    );
    return 0;
  }

  if (!opts.yes) {
    const verb = targets.length === 1 ? 'this' : `these ${targets.length}`;
    const ok = await confirmYn(`Upgrade ${verb} app(s)?`);
    if (!ok) {
      println(c.dim('Aborted.'));
      return 1;
    }
  }

  // Run installs sequentially. Reuses cmdInstall which already drives the
  // catalog → manifest → payload → engine pipeline.
  let failures = 0;
  for (const cand of targets) {
    println(c.cyan(`→ Upgrading ${cand.appId} ${cand.fromVersion} → ${cand.toVersion}`));
    const rc = await cmdInstall(host, { appId: cand.appId, kind: cand.kind, yes: true });
    if (rc !== 0) failures++;
  }

  if (failures > 0) {
    println(c.red(`${failures} upgrade(s) failed.`));
    return 1;
  }
  println(c.green(`✓ Upgraded ${targets.length} app(s).`));
  return 0;
}
