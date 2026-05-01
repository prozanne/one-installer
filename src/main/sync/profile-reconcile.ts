/**
 * profile-reconcile — drives drift entries through the existing install /
 * uninstall pipelines.
 *
 * Pure orchestration: takes a `ProfileDrift[]` list and a small set of
 * delegate functions (install / uninstall, both injected). Returns a
 * structured `ReconcileReport` that the IPC handler broadcasts and the UI
 * surfaces.
 *
 * Why delegates instead of importing the IPC handlers directly:
 *   - Keeps this module testable in isolation with fakes.
 *   - The wizard-answers branch on the profile entry needs to call
 *     `catalog:install` then immediately `install:run` with the operator-
 *     supplied answers — a flow that doesn't exist as a single IPC. So
 *     the wiring layer in electron-main composes both calls; here we
 *     just describe the contract.
 *
 * Concurrency: reconciles are serialized by the caller (a single
 * in-flight flag in electron-main). Within one reconcile, drift entries
 * are processed sequentially. Parallelism is tempting but pulls in
 * journal/state contention we already serialize — see `installed-store`'s
 * update queue.
 */
import type { ProfileDrift } from './profile-diff';
import type { CatalogKindT } from '@shared/ipc-types';

/**
 * Result of installing/uninstalling one drift entry. The reconcile loop
 * does not throw — every step lands as a `ReconcileAction` so the report
 * is complete even when individual steps fail.
 */
export type ReconcileAction =
  | { kind: 'installed'; appId: string; version: string }
  | { kind: 'updated'; appId: string; fromVersion: string; toVersion: string }
  | { kind: 'uninstalled'; appId: string }
  | { kind: 'skipped'; appId: string; reason: string }
  | { kind: 'failed'; appId: string; error: string };

export interface ReconcileReport {
  /** Profile name (for display). */
  profileName: string;
  startedAt: string;
  finishedAt: string;
  /**
   * If true, the caller invoked the loop in dry-run mode — drift was
   * computed but no install/uninstall was attempted. The actions list is
   * synthesized from drift entries with reason="dry-run".
   */
  dryRun: boolean;
  actions: ReconcileAction[];
}

export interface ReconcileDeps {
  /**
   * Programmatic install entry-point. Wires through `catalog:install` for
   * the resolution + download + signature checks, then `install:run` with
   * the supplied wizardAnswers — same flow a user clicks through.
   *
   * Returns the installed version (manifest.version) on success.
   *
   * `wizardAnswers` is treated as a dictionary; missing keys fall through
   * to manifest defaults inside the engine. Fields that the manifest
   * doesn't recognize are ignored.
   */
  installApp: (input: {
    appId: string;
    kind: CatalogKindT;
    wizardAnswers: Record<string, unknown>;
    /**
     * Channel pin from the profile, propagated into installed-state so
     * the per-app update flow honors it.
     */
    channel: 'stable' | 'beta' | 'internal';
  }) => Promise<{ ok: true; version: string } | { ok: false; error: string }>;

  /** Programmatic uninstall — same pipeline as `uninstall:run`. */
  uninstallApp: (input: { appId: string }) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface ReconcileInput {
  profileName: string;
  drift: ProfileDrift[];
  /** When true, no installApp/uninstallApp calls are made; report shows the planned actions only. */
  dryRun: boolean;
}

export async function reconcileProfile(
  deps: ReconcileDeps,
  input: ReconcileInput,
): Promise<ReconcileReport> {
  const startedAt = new Date().toISOString();
  const actions: ReconcileAction[] = [];

  for (const d of input.drift) {
    if (input.dryRun) {
      actions.push(synthDryRunAction(d));
      continue;
    }

    if (d.kind === 'missing') {
      if (d.unresolvable) {
        actions.push({
          kind: 'failed',
          appId: d.profileApp.id,
          error: `Profile names '${d.profileApp.id}' but the catalog has no such item. Update the catalog or remove the entry.`,
        });
        continue;
      }
      const r = await deps.installApp({
        appId: d.profileApp.id,
        kind: d.profileApp.kind,
        wizardAnswers: d.profileApp.wizardAnswers,
        channel: d.profileApp.channel,
      });
      if (r.ok) {
        actions.push({ kind: 'installed', appId: d.profileApp.id, version: r.version });
      } else {
        actions.push({ kind: 'failed', appId: d.profileApp.id, error: r.error });
      }
      continue;
    }

    if (d.kind === 'outdated') {
      const r = await deps.installApp({
        appId: d.profileApp.id,
        kind: d.profileApp.kind,
        wizardAnswers: d.profileApp.wizardAnswers,
        channel: d.profileApp.channel,
      });
      if (r.ok) {
        actions.push({
          kind: 'updated',
          appId: d.profileApp.id,
          fromVersion: d.fromVersion,
          toVersion: r.version,
        });
      } else {
        actions.push({ kind: 'failed', appId: d.profileApp.id, error: r.error });
      }
      continue;
    }

    if (d.kind === 'extra') {
      const r = await deps.uninstallApp({ appId: d.appId });
      if (r.ok) {
        actions.push({ kind: 'uninstalled', appId: d.appId });
      } else {
        actions.push({ kind: 'failed', appId: d.appId, error: r.error });
      }
      continue;
    }
  }

  return {
    profileName: input.profileName,
    startedAt,
    finishedAt: new Date().toISOString(),
    dryRun: input.dryRun,
    actions,
  };
}

function synthDryRunAction(d: ProfileDrift): ReconcileAction {
  if (d.kind === 'missing') {
    return { kind: 'skipped', appId: d.profileApp.id, reason: 'dry-run: would install' };
  }
  if (d.kind === 'outdated') {
    return {
      kind: 'skipped',
      appId: d.profileApp.id,
      reason: `dry-run: would update ${d.fromVersion} → ${d.toVersion}`,
    };
  }
  return { kind: 'skipped', appId: d.appId, reason: 'dry-run: would uninstall' };
}
