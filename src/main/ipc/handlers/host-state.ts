/**
 * host:exportState / host:importState — the D-bonus state migration helper.
 *
 * Export: dump the safe-to-round-trip subset of `installed.json` as JSON.
 * Settings included; per-app fields trimmed to (version, scope, kind,
 * channel, autoUpdate, wizardAnswers). Manifest snapshots and the journal
 * are excluded — those are huge, host-specific, and can be re-derived by
 * the destination host on first reconcile.
 *
 * Import: validate the blob, merge into installed.json. We treat the
 * blob as authoritative for the listed apps' metadata fields but DO NOT
 * synthesize a manifest snapshot — the destination must reinstall to get
 * the real on-disk state. The merge marks each entry with a placeholder
 * manifest snapshot good enough for the UI to show "needs reinstall" and
 * the sync engine to pick it up as drift on the next reconcile.
 *
 * Why metadata-only by default: copying installed.json verbatim would
 * carry over hard-coded install paths and per-host registry shim handles
 * that don't translate. The intended workflow is "import on the new
 * host → press Sync → installs run with the same wizard answers."
 */
import type {
  HostExportStateResT,
  HostImportStateReqT,
  HostImportStateResT,
  StateBackupT,
} from '@shared/ipc-types';
import { HostExportStateReq, HostImportStateReq } from '@shared/ipc-types';
import type { Manifest } from '@shared/schema';
import type { InstalledStore } from '@main/state/installed-store';

export interface HostStateDeps {
  installedStore: InstalledStore;
  hostVersion: string;
  /**
   * Used to create a placeholder manifestSnapshot when restoring an entry
   * that didn't exist before. The placeholder satisfies the InstalledApp
   * schema (so the import succeeds) but is clearly fake — the next
   * reconcile or per-app update will replace it with the real one.
   */
  placeholderManifestForId: (appId: string) => Manifest;
}

export async function handleHostExportState(
  deps: HostStateDeps,
  raw: unknown,
): Promise<HostExportStateResT> {
  const parsed = HostExportStateReq.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, error: 'invalid request' };
  try {
    const state = await deps.installedStore.read();
    const apps: StateBackupT['apps'] = {};
    for (const [appId, entry] of Object.entries(state.apps)) {
      apps[appId] = {
        version: entry.version,
        installScope: entry.installScope,
        wizardAnswers: entry.wizardAnswers,
        kind: entry.kind,
        updateChannel: entry.updateChannel,
        autoUpdate: entry.autoUpdate,
      };
    }
    const backup: StateBackupT = {
      backupSchema: 1,
      exportedAt: new Date().toISOString(),
      hostVersion: deps.hostVersion,
      apps,
      settings: state.settings,
    };
    return { ok: true, backup };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function handleHostImportState(
  deps: HostStateDeps,
  raw: unknown,
): Promise<HostImportStateResT> {
  const parsed = HostImportStateReq.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'invalid backup payload' };
  const req = parsed.data as HostImportStateReqT;
  try {
    const now = new Date().toISOString();
    let merged = 0;
    await deps.installedStore.update((s) => {
      // Replace settings wholesale — the user explicitly imported them.
      s.settings = { ...s.settings, ...req.backup.settings };
      // Merge apps. An entry already on disk wins on (version, manifest,
      // installPath) — those describe ground truth; we don't fabricate a
      // path for an already-installed app. Only `wizardAnswers` and
      // `autoUpdate` are pulled from the backup so a reimport doesn't
      // overwrite a real install with the placeholder.
      for (const [appId, b] of Object.entries(req.backup.apps)) {
        const existing = s.apps[appId];
        if (existing) {
          existing.wizardAnswers = b.wizardAnswers;
          existing.autoUpdate = b.autoUpdate;
          existing.updateChannel = b.updateChannel;
          merged++;
          continue;
        }
        s.apps[appId] = {
          version: b.version,
          installScope: b.installScope,
          installPath: '', // empty — flags "needs reinstall" to renderer
          wizardAnswers: b.wizardAnswers,
          journal: [],
          manifestSnapshot: deps.placeholderManifestForId(appId),
          installedAt: now,
          updateChannel: b.updateChannel,
          autoUpdate: b.autoUpdate,
          source: 'catalog',
          kind: b.kind,
        };
        merged++;
      }
    });
    void req.reinstall; // honored at the IPC wiring layer (call sync:run after)
    return { ok: true, appsMerged: merged };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
