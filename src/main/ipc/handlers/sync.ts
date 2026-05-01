/**
 * sync:status / sync:run handlers — wire the sync engine to IPC.
 *
 * The handler is intentionally thin: every step is a delegate the host
 * provides at registration time so this module is unit-testable without
 * Electron, fetch, or the full engine. The wiring layer in
 * `electron-main.ts` composes the real network/install delegates.
 *
 * Status semantics:
 *   - `enabled: false` → no syncProfile in vdx.config.json. UI hides the tab.
 *   - `enabled: true, profileName: null` → configured but never fetched.
 *   - `enabled: true, lastReport: null` → fetched but never reconciled.
 */
import type {
  SyncRunReqT,
  SyncRunResT,
  SyncStatusResT,
  SyncReportEventT,
} from '@shared/ipc-types';
import { SyncRunReq, SyncStatusReq } from '@shared/ipc-types';
import type { SyncProfileT, InstalledStateT } from '@shared/schema';
import type { ReconcileReport } from '@main/sync';

export interface SyncHandlerDeps {
  /** Profile URL from vdx.config.json. Null when sync is unconfigured. */
  profileUrl: () => string | null;
  /** Most-recently-fetched profile (in-memory cache). Null if never fetched. */
  cachedProfile: () => SyncProfileT | null;
  /** Read installed.json — surfaces `lastSyncReport`, `syncProfileFreshness`. */
  readInstalled: () => Promise<InstalledStateT>;
  /** True iff a reconcile is currently in flight. Caller maintains this flag. */
  inFlight: () => boolean;
  /**
   * Invoked by `sync:run`. Performs fetch+verify+diff+reconcile end-to-end
   * and returns the report (also persisted to installed.json by the caller).
   *
   * Returning a Result lets the handler turn an engine-side error into a
   * clean IPC `ok: false` without throwing.
   */
  runReconcile: (input: { dryRun: boolean }) => Promise<
    { ok: true; report: ReconcileReport } | { ok: false; error: string }
  >;
}

export async function handleSyncStatus(
  deps: SyncHandlerDeps,
  raw: unknown,
): Promise<SyncStatusResT> {
  const parsed = SyncStatusReq.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, error: 'invalid request' };

  const url = deps.profileUrl();
  if (!url) {
    return {
      ok: true,
      enabled: false,
      profileUrl: null,
      profileName: null,
      lastReconciledAt: null,
      lastReport: null,
      inFlight: false,
    };
  }

  try {
    const state = await deps.readInstalled();
    const cached = deps.cachedProfile();
    const lastReport = (state.lastSyncReport ?? null) as SyncReportEventT | null;
    return {
      ok: true,
      enabled: true,
      profileUrl: url,
      profileName: cached?.name ?? lastReport?.profileName ?? null,
      lastReconciledAt: lastReport?.finishedAt ?? null,
      lastReport,
      inFlight: deps.inFlight(),
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function handleSyncRun(
  deps: SyncHandlerDeps,
  raw: unknown,
): Promise<SyncRunResT> {
  const parsed = SyncRunReq.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, error: 'invalid request' };
  const req = parsed.data as SyncRunReqT;

  if (!deps.profileUrl()) {
    return { ok: false, error: 'No syncProfile configured in vdx.config.json' };
  }
  if (deps.inFlight()) {
    return { ok: false, error: 'A reconcile is already in flight; please wait for it to finish.' };
  }

  const r = await deps.runReconcile({ dryRun: req.dryRun });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, report: r.report };
}
