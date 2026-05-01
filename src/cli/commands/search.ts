/**
 * `vdx search <query>` — substring match against catalog id / name /
 * description / tags. Single string argument; quoting handles spaces.
 */
import type { CliHost } from '../host-bootstrap';
import { c, pad, println } from '../output';
import { fetchCatalogVerified } from '@main/catalog';

export interface SearchOpts {
  query: string;
  kind: 'app' | 'agent';
  json: boolean;
}

export async function cmdSearch(host: CliHost, opts: SearchOpts): Promise<number> {
  if (!host.packageSource) {
    println(c.red('No catalog source configured.'));
    return 1;
  }
  let items;
  try {
    const r = await fetchCatalogVerified(host.packageSource, { trustRoots: host.trustRoots });
    if ('notModified' in r) return 0;
    items = r.catalog.apps;
  } catch (e) {
    println(c.red(`Catalog fetch failed: ${(e as Error).message}`));
    return 1;
  }
  const q = opts.query.toLowerCase();
  const matches = items.filter((it) => {
    if (it.id.toLowerCase().includes(q)) return true;
    const name = it.displayName?.default?.toLowerCase() ?? '';
    if (name.includes(q)) return true;
    const desc = it.displayDescription?.default?.toLowerCase() ?? '';
    if (desc.includes(q)) return true;
    if (it.tags.some((t) => t.toLowerCase().includes(q))) return true;
    return false;
  });

  if (opts.json) {
    println(JSON.stringify(matches, null, 2));
    return 0;
  }

  if (matches.length === 0) {
    println(c.dim(`No matches for "${opts.query}".`));
    return 1;
  }

  println(c.bold(pad('ID', 32) + pad('VERSION', 12) + 'NAME'));
  for (const item of matches) {
    println(
      pad(item.id, 32) +
        pad(item.latestVersion ?? '—', 12) +
        c.dim(item.displayName?.default ?? ''),
    );
  }
  return 0;
}
