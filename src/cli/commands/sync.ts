/**
 * `vdx sync [--dry-run]` — fetch + verify the configured profile, diff
 * against installed.json, reconcile.
 *
 * Mirrors the IPC `sync:run` handler. We compose the same delegates here
 * (install, uninstall) but feed them `cmdInstall` / `cmdRemove` from the
 * CLI so the user sees the same status output as a manual install.
 */
import type { CliHost } from '../host-bootstrap';
import { c, println } from '../output';
import { diffProfile, fetchProfile, reconcileProfile } from '@main/sync';
import { fetchCatalogVerified } from '@main/catalog';
import type { CatalogT } from '@shared/schema';
import type { CatalogKindT } from '@shared/ipc-types';
import { cmdInstall } from './install';
import { cmdRemove } from './remove';

export interface SyncOpts {
  dryRun: boolean;
  yes: boolean;
}

export async function cmdSync(host: CliHost, opts: SyncOpts): Promise<number> {
  if (!host.config.syncProfile) {
    println(c.red('No syncProfile configured in vdx.config.json.'));
    return 1;
  }

  const fetched = await fetchProfile({
    url: host.config.syncProfile.url,
    sigUrl: host.config.syncProfile.sigUrl,
    trustRoots: host.trustRoots,
    timeoutMs: 15_000,
    userAgent: `vdx-cli/${host.hostVersion}`,
  });
  if (!fetched.ok) {
    println(c.red(`Profile fetch failed: ${fetched.error}`));
    return 1;
  }
  if (!fetched.value.signatureValid) {
    println(c.red('Profile signature did not verify against any trust root.'));
    return 1;
  }
  const profile = fetched.value.profile;

  // CLI doesn't run the IPC catalog cache; fetch the catalog now if the
  // profile references catalog items. Best-effort: errors here just leave
  // diffs as `unresolvable` which the reconcile reports.
  let appCatalog: CatalogT | null = null;
  if (host.packageSource) {
    try {
      const r = await fetchCatalogVerified(host.packageSource, { trustRoots: host.trustRoots });
      if ('catalog' in r) appCatalog = r.catalog;
    } catch {
      /* ignore — surfaced as unresolvable */
    }
  }

  const state = await host.installedStore.read();
  const drift = diffProfile({
    profile,
    installed: state.apps,
    getCatalog: (kind: CatalogKindT) => (kind === 'app' ? appCatalog : null),
  });

  if (drift.length === 0) {
    println(c.green('✓ Already in sync.'));
    return 0;
  }

  println(c.bold(`Profile "${profile.name}" — ${drift.length} drift item(s):`));
  for (const d of drift) {
    if (d.kind === 'missing') {
      println(`  ${c.cyan('+ install ')} ${d.profileApp.id}`);
    } else if (d.kind === 'outdated') {
      println(`  ${c.yellow('↑ update  ')} ${d.profileApp.id} (${d.fromVersion} → ${d.toVersion})`);
    } else {
      println(`  ${c.red('- remove  ')} ${d.appId}`);
    }
  }

  if (opts.dryRun) {
    println(c.dim('\nDry run — no changes applied.'));
    return 0;
  }

  if (!opts.yes) {
    println(c.dim('\n--yes not set; pass --yes to apply.'));
    return 1;
  }

  const report = await reconcileProfile(
    {
      installApp: async (input) => {
        const rc = await cmdInstall(host, { appId: input.appId, kind: input.kind, yes: true });
        if (rc !== 0) return { ok: false, error: 'install failed' };
        const s = await host.installedStore.read();
        const e = s.apps[input.appId];
        if (!e) return { ok: false, error: 'install completed but entry missing' };
        // Pin the channel post-install so the per-app update flow honors it.
        await host.installedStore.update((st) => {
          const ent = st.apps[input.appId];
          if (ent) ent.updateChannel = input.channel;
        });
        return { ok: true, version: e.version };
      },
      uninstallApp: async (input) => {
        const rc = await cmdRemove(host, { appId: input.appId, yes: true });
        if (rc !== 0) return { ok: false, error: 'uninstall failed' };
        return { ok: true };
      },
    },
    { profileName: profile.name, drift, dryRun: false },
  );

  // Persist the report so the GUI sees it on next launch.
  await host.installedStore.update((s) => {
    s.lastSyncReport = {
      profileName: report.profileName,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      dryRun: report.dryRun,
      actions: report.actions as unknown as Array<Record<string, unknown>>,
    };
    s.syncProfileFreshness = profile.updatedAt;
  });

  const failed = report.actions.filter((a) => a.kind === 'failed').length;
  if (failed > 0) {
    println(c.red(`\n${failed} action(s) failed.`));
    return 1;
  }
  println(c.green(`\n✓ Reconcile complete — ${report.actions.length} action(s).`));
  return 0;
}
