/**
 * `vdx export [<file>]` / `vdx import <file>` — backup / restore.
 *
 * Same payload shape the `host:exportState` / `host:importState` IPC
 * handlers produce; the host can import a CLI export and vice versa.
 *
 * Export defaults to stdout (so a user can `vdx export | scp - host:`).
 * Import requires an explicit file path; reading stdin would conflict
 * with confirmYn's TTY logic.
 */
import * as nodeFs from 'node:fs';
import type { CliHost } from '../host-bootstrap';
import { c, println } from '../output';
import { handleHostExportState, handleHostImportState } from '@main/ipc/handlers/host-state';
import type { Manifest } from '@shared/schema';

const PLACEHOLDER: (id: string) => Manifest = (appId) => ({
  schemaVersion: 1,
  id: appId,
  name: { default: appId },
  version: '0.0.0',
  publisher: 'imported',
  description: { default: 'Restored from backup — reinstall via vdx sync.' },
  size: { download: 0, installed: 0 },
  payload: { filename: 'placeholder.zip', sha256: '0'.repeat(64), compressedSize: 1 },
  minHostVersion: '0.0.0',
  targets: { os: 'win32', arch: ['x64'] },
  installScope: { supports: ['user'], default: 'user' },
  requiresReboot: false,
  wizard: [{ type: 'summary' }],
  install: { extract: [{ from: '.', to: '.' }] },
  postInstall: [],
  uninstall: { removePaths: [], removeShortcuts: true, removeEnvPath: true },
});

export async function cmdExport(host: CliHost, opts: { file: string | null }): Promise<number> {
  const r = await handleHostExportState(
    {
      installedStore: host.installedStore,
      hostVersion: host.hostVersion,
      placeholderManifestForId: PLACEHOLDER,
    },
    {},
  );
  if (!r.ok) {
    println(c.red(`Export failed: ${r.error}`));
    return 1;
  }
  const json = JSON.stringify(r.backup, null, 2);
  if (opts.file) {
    nodeFs.writeFileSync(opts.file, json);
    println(c.green(`✓ Wrote ${opts.file}`));
  } else {
    process.stdout.write(json + '\n');
  }
  return 0;
}

export async function cmdImport(host: CliHost, opts: { file: string }): Promise<number> {
  let bytes: string;
  try {
    bytes = nodeFs.readFileSync(opts.file, 'utf-8');
  } catch (e) {
    println(c.red(`Could not read ${opts.file}: ${(e as Error).message}`));
    return 1;
  }
  let backup: unknown;
  try {
    backup = JSON.parse(bytes);
  } catch (e) {
    println(c.red(`Invalid JSON: ${(e as Error).message}`));
    return 1;
  }
  const r = await handleHostImportState(
    {
      installedStore: host.installedStore,
      hostVersion: host.hostVersion,
      placeholderManifestForId: PLACEHOLDER,
    },
    { backup, reinstall: false },
  );
  if (!r.ok) {
    println(c.red(`Import failed: ${r.error}`));
    return 1;
  }
  println(c.green(`✓ Imported ${r.appsMerged} app entries.`));
  println(c.dim('Run `vdx sync --yes` to reinstall the actual binaries.'));
  return 0;
}
