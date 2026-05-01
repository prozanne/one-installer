/**
 * `vdx list` — print installed apps (default) or catalog items.
 *
 * Output is column-aligned plain text by default (suitable for `grep` /
 * `awk` pipelines). `--json` switches to machine-readable.
 */
import type { CliHost } from '../host-bootstrap';
import { c, pad, println } from '../output';
import { fetchCatalogVerified } from '@main/catalog';
import type { CatalogT } from '@shared/schema';

export interface ListOpts {
  /** Read installed.json instead of the catalog. */
  installed: boolean;
  /** 'app' (default) or 'agent'. */
  kind: 'app' | 'agent';
  json: boolean;
}

export async function cmdList(host: CliHost, opts: ListOpts): Promise<number> {
  if (opts.installed) return listInstalled(host, opts);
  return listCatalog(host, opts);
}

async function listInstalled(host: CliHost, opts: ListOpts): Promise<number> {
  const state = await host.installedStore.read();
  const entries = Object.entries(state.apps).filter(([, v]) => v.kind === opts.kind);

  if (opts.json) {
    println(JSON.stringify(entries, null, 2));
    return 0;
  }

  if (entries.length === 0) {
    println(c.dim(`No ${opts.kind === 'agent' ? 'agents' : 'apps'} installed.`));
    return 0;
  }

  println(c.bold(pad('ID', 32) + pad('VERSION', 14) + pad('CHANNEL', 10) + 'INSTALLED'));
  for (const [appId, entry] of entries) {
    println(
      pad(appId, 32) +
        pad(entry.version, 14) +
        pad(entry.updateChannel, 10) +
        c.gray(new Date(entry.installedAt).toLocaleDateString()),
    );
  }
  return 0;
}

async function listCatalog(host: CliHost, opts: ListOpts): Promise<number> {
  if (!host.packageSource) {
    println(c.red('No catalog source configured (Phase 1.0 supports local-fs only).'));
    return 1;
  }
  let catalog: CatalogT;
  try {
    const r = await fetchCatalogVerified(host.packageSource, { trustRoots: host.trustRoots });
    if ('notModified' in r) {
      println(c.dim('Catalog not modified, no cached body for CLI.'));
      return 0;
    }
    catalog = r.catalog;
  } catch (e) {
    println(c.red(`Catalog fetch failed: ${(e as Error).message}`));
    return 1;
  }

  if (opts.json) {
    println(JSON.stringify(catalog.apps, null, 2));
    return 0;
  }

  if (catalog.apps.length === 0) {
    println(c.dim('Catalog is empty.'));
    return 0;
  }

  println(c.bold(pad('ID', 32) + pad('LATEST', 14) + pad('CHANNEL', 14) + 'NAME'));
  for (const item of catalog.apps) {
    if (item.deprecated) continue;
    const name = item.displayName?.default ?? '';
    println(
      pad(item.id, 32) +
        pad(item.latestVersion ?? '—', 14) +
        pad(item.channels.join('/'), 14) +
        c.dim(name),
    );
  }
  return 0;
}
