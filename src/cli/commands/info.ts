/**
 * `vdx info <id>` — describe an installed app or catalog entry.
 */
import type { CliHost } from '../host-bootstrap';
import { c, println } from '../output';
import { fetchCatalogVerified } from '@main/catalog';

export interface InfoOpts {
  appId: string;
  kind: 'app' | 'agent';
  json: boolean;
}

export async function cmdInfo(host: CliHost, opts: InfoOpts): Promise<number> {
  const state = await host.installedStore.read();
  const installed = state.apps[opts.appId] ?? null;

  let catalogItem: unknown = null;
  if (host.packageSource) {
    try {
      const r = await fetchCatalogVerified(host.packageSource, { trustRoots: host.trustRoots });
      if ('catalog' in r) {
        catalogItem = r.catalog.apps.find((a) => a.id === opts.appId) ?? null;
      }
    } catch {
      // Fail silently — info still has the installed half.
    }
  }

  if (!installed && !catalogItem) {
    println(c.red(`Unknown app: ${opts.appId}`));
    return 1;
  }

  if (opts.json) {
    println(JSON.stringify({ installed, catalog: catalogItem }, null, 2));
    return 0;
  }

  println(c.bold(opts.appId));
  if (installed) {
    println(`  ${c.dim('installed:')} v${installed.version} (${installed.installScope}, ${installed.kind})`);
    println(`  ${c.dim('channel:')}   ${installed.updateChannel}`);
    println(`  ${c.dim('autoUpd:')}   ${installed.autoUpdate}`);
    println(`  ${c.dim('path:')}      ${installed.installPath || c.yellow('— missing — needs reinstall —')}`);
    println(`  ${c.dim('source:')}    ${installed.source}`);
  } else {
    println(c.dim('  not installed'));
  }
  if (catalogItem) {
    const item = catalogItem as { latestVersion?: string; deprecated?: boolean; displayName?: { default?: string } };
    println(`  ${c.dim('catalog:')}   ${item.latestVersion ?? '—'}${item.deprecated ? c.yellow(' [deprecated]') : ''}`);
    if (item.displayName?.default) println(`  ${c.dim('name:')}      ${item.displayName.default}`);
  }
  return 0;
}
