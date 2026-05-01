/**
 * Per-app update IPC handlers.
 *
 * `apps:checkUpdates` diffs installed apps against the cached catalog (no
 * network — it operates on whatever the latest catalog:fetch loaded) and
 * returns update candidates.
 *
 * `apps:updateRun` triggers a single-app update by routing through the same
 * catalog:install pipeline that fresh installs use. The wizard answer-reuse
 * logic in `diffWizardForReuse` lives in the engine; the wizard skip-step
 * silent path is engine-side too. v1 of this handler always returns a
 * sessionId so the renderer drives the wizard — silent auto-install is
 * deferred to v2 once we have an explicit `apps:updateSilent` channel that
 * acknowledges no UI surface beyond a toast.
 */
import type {
  AppUpdateCandidateT,
  AppsCheckUpdatesResT,
  AppsUpdateRunReqT,
  AppsUpdateRunResT,
  CatalogInstallResT,
  CatalogKindT,
} from '@shared/ipc-types';
import { AppsCheckUpdatesReq, AppsUpdateRunReq } from '@shared/ipc-types';
import type { CatalogT, InstalledStateT } from '@shared/schema';
import { diffInstalledVsCatalog } from '@main/engine/diff-versions';

export interface AppsUpdateHandlerDeps {
  /** Read installed.json (the .apps map). */
  readInstalled: () => Promise<InstalledStateT['apps']>;
  /** Look up the cached catalog body for a given kind. Returns null when none cached. */
  getCatalog: (kind: CatalogKindT) => CatalogT | null;
  /** Active update channel — settings.updateChannel. */
  channel: () => 'stable' | 'beta' | 'internal';
  /**
   * Delegate that performs the catalog:install side-effect for a given
   * appId/kind. Production wires this to the existing catalog:install
   * handler; tests pass a fake. Returning a CatalogInstallRes lets the
   * caller pass it straight back to the renderer.
   */
  triggerCatalogInstall: (kind: CatalogKindT, appId: string) => Promise<CatalogInstallResT>;
}

export async function handleAppsCheckUpdates(
  deps: AppsUpdateHandlerDeps,
  raw: unknown,
): Promise<AppsCheckUpdatesResT> {
  const parsed = AppsCheckUpdatesReq.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, error: 'invalid request' };
  try {
    const installed = await deps.readInstalled();
    const channel = deps.channel();
    const candidates: AppUpdateCandidateT[] = [];

    for (const kind of ['app', 'agent'] as const) {
      const catalog = deps.getCatalog(kind);
      if (!catalog) continue;
      // Filter installed map to entries matching this kind so two app entries
      // with the same id (sideload + catalog) don't collide.
      const installedOfKind: InstalledStateT['apps'] = {};
      for (const [id, app] of Object.entries(installed)) {
        if (app.kind === kind) installedOfKind[id] = app;
      }
      const diffed = diffInstalledVsCatalog({
        installed: installedOfKind,
        catalogItems: catalog.apps,
        channel,
      });
      for (const c of diffed) {
        const display =
          c.item.displayName?.default ??
          installed[c.appId]?.manifestSnapshot.name.default ??
          c.appId;
        candidates.push({
          appId: c.appId,
          fromVersion: c.fromVersion,
          toVersion: c.toVersion,
          displayName: display,
          kind: c.kind,
          policy: c.policy,
        });
      }
    }
    return { ok: true, candidates };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function handleAppsUpdateRun(
  deps: AppsUpdateHandlerDeps,
  raw: unknown,
): Promise<AppsUpdateRunResT> {
  const parsed = AppsUpdateRunReq.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'invalid request' };
  const req = parsed.data as AppsUpdateRunReqT;

  // Determine kind by looking up the installed entry. We could also re-diff
  // here, but the renderer just sent us an appId from a candidate list it
  // received from `apps:checkUpdates` ~seconds earlier, so the kind we
  // recorded then is still authoritative.
  const installed = await deps.readInstalled();
  const entry = installed[req.appId];
  if (!entry) return { ok: false, error: `Not installed: ${req.appId}` };

  // Hand off to the same catalog:install path the user takes from the
  // catalog tab. The catalog handler's session bookkeeping covers
  // wizard-answer reuse internally — the renderer just navigates to
  // /wizard with the returned sessionId.
  const installRes = await deps.triggerCatalogInstall(entry.kind, req.appId);
  if (!installRes.ok) {
    return { ok: false, error: installRes.error };
  }
  return {
    ok: true,
    installed: false,
    sessionId: installRes.sessionId,
    manifest: installRes.manifest,
    defaultInstallPath: installRes.defaultInstallPath,
    signatureValid: installRes.signatureValid,
  };
}
