/**
 * `vdx install <id>` — install from catalog or sideload from .vdxpkg.
 *
 * Mirrors the catalog:install + install:run pipeline used by the GUI.
 * The CLI version skips the wizard entirely and just feeds manifest
 * defaults; for fields where `default` would result in invalid input
 * (path that doesn't exist, etc.), the install will fail loud with the
 * same engine error the GUI surfaces.
 *
 * Sideload mode: when the argument looks like a `.vdxpkg` path (or starts
 * with `./`), we go through `parseVdxpkg` instead of resolving via catalog.
 */
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import type { CliHost } from '../host-bootstrap';
import { c, clearStatus, confirmYn, println, status } from '../output';
import {
  parseVdxpkg,
  runInstall,
} from '@main/engine';
import { fetchCatalogVerified, fetchManifestVerified, fetchPayloadStream } from '@main/catalog';
import type { Manifest } from '@shared/schema';

export interface InstallOpts {
  appId: string;
  kind: 'app' | 'agent';
  yes: boolean;
}

export async function cmdInstall(host: CliHost, opts: InstallOpts): Promise<number> {
  // Sideload heuristic: argument names a real readable file with .vdxpkg ext.
  if (opts.appId.endsWith('.vdxpkg') && nodeFs.existsSync(opts.appId)) {
    return installFromVdxpkg(host, opts);
  }

  if (!host.packageSource) {
    println(c.red('No catalog source configured (Phase 1.0 supports local-fs only).'));
    return 1;
  }

  // Resolve via catalog.
  let latestVersion: string;
  try {
    const r = await fetchCatalogVerified(host.packageSource, { trustRoots: host.trustRoots });
    if ('notModified' in r) {
      println(c.red('Catalog returned 304 but CLI has no cache.'));
      return 1;
    }
    const item = r.catalog.apps.find((a) => a.id === opts.appId);
    if (!item) {
      println(c.red(`Item not in catalog: ${opts.appId}`));
      return 1;
    }
    latestVersion = item.latestVersion ?? 'latest';
  } catch (e) {
    println(c.red(`Catalog fetch failed: ${(e as Error).message}`));
    return 1;
  }

  if (!opts.yes) {
    const ok = await confirmYn(
      `Install ${c.bold(opts.appId)} ${c.dim('v' + latestVersion)} from catalog?`,
    );
    if (!ok) {
      println(c.dim('Aborted.'));
      return 1;
    }
  }

  let manifest: Manifest;
  try {
    manifest = await fetchManifestVerified(host.packageSource, opts.appId, latestVersion, {
      trustRoots: host.trustRoots,
    });
  } catch (e) {
    println(c.red(`Manifest fetch failed: ${(e as Error).message}`));
    return 1;
  }

  // Stream payload, show simple status.
  const chunks: Uint8Array[] = [];
  let downloaded = 0;
  const total = manifest.payload.compressedSize;
  try {
    for await (const chunk of fetchPayloadStream(
      host.packageSource,
      opts.appId,
      manifest.version,
      { expectedSha256: manifest.payload.sha256 },
    )) {
      chunks.push(chunk);
      downloaded += chunk.byteLength;
      const pct = total > 0 ? Math.min(99, Math.round((downloaded / total) * 100)) : 0;
      status(`Downloading ${opts.appId}… ${pct}%`);
    }
  } catch (e) {
    clearStatus();
    println(c.red(`Payload fetch failed: ${(e as Error).message}`));
    return 1;
  }
  clearStatus();

  const payloadBytes = Buffer.concat(chunks);
  const parsed = await parseVdxpkg(payloadBytes, host.trustRoots);
  if (!parsed.ok) {
    println(c.red(`Package parse failed: ${parsed.error}`));
    return 1;
  }

  const sysVars = host.platform.systemVars();
  const root = sysVars['LocalAppData'] ?? sysVars['Home'] ?? '/';
  const installPath = join(root, 'Programs', 'Samsung', parsed.value.manifest.id);
  const wizardAnswers: Record<string, unknown> = { installPath };

  return performInstall(host, parsed.value.manifest, parsed.value.payloadBytes, wizardAnswers, opts.kind);
}

async function installFromVdxpkg(host: CliHost, opts: InstallOpts): Promise<number> {
  let bytes: Buffer;
  try {
    bytes = nodeFs.readFileSync(opts.appId);
  } catch (e) {
    println(c.red(`Could not read ${opts.appId}: ${(e as Error).message}`));
    return 1;
  }
  const parsed = await parseVdxpkg(bytes, host.trustRoots);
  if (!parsed.ok) {
    println(c.red(`Package parse failed: ${parsed.error}`));
    return 1;
  }
  if (!opts.yes) {
    const ok = await confirmYn(
      `Sideload ${c.bold(parsed.value.manifest.id)} ${c.dim('v' + parsed.value.manifest.version)}?`,
    );
    if (!ok) {
      println(c.dim('Aborted.'));
      return 1;
    }
  }
  const sysVars = host.platform.systemVars();
  const root = sysVars['LocalAppData'] ?? sysVars['Home'] ?? '/';
  const installPath = join(root, 'Programs', 'Samsung', parsed.value.manifest.id);
  return performInstall(
    host,
    parsed.value.manifest,
    parsed.value.payloadBytes,
    { installPath },
    'app',
  );
}

async function performInstall(
  host: CliHost,
  manifest: Manifest,
  payloadBytes: Buffer,
  wizardAnswers: Record<string, unknown>,
  kind: 'app' | 'agent',
): Promise<number> {
  status(`Installing ${manifest.id}…`);
  const result = await runInstall({
    manifest,
    payloadBytes,
    wizardAnswers,
    platform: host.platform,
    runner: host.runner,
    hostExePath: process.execPath,
    lockDir: host.paths.locksDir,
  });
  clearStatus();
  if (!result.ok) {
    println(c.red(`Install failed: ${result.error}`));
    return 1;
  }
  await host.installedStore.update((s) => {
    s.apps[manifest.id] = {
      version: manifest.version,
      installScope: manifest.installScope.default,
      installPath: result.value.installPath,
      wizardAnswers,
      journal: result.value.committed.steps,
      manifestSnapshot: manifest,
      installedAt: new Date().toISOString(),
      updateChannel: 'stable',
      autoUpdate: 'ask',
      source: 'catalog',
      kind,
    };
  });
  println(c.green(`✓ Installed ${manifest.id} v${manifest.version}`));
  return 0;
}
