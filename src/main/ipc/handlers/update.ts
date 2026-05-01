/**
 * Pure update IPC handlers — extracted from `electron-main.ts`.
 *
 * The skipped tests in `test/ipc/handlers-update.test.ts` exist for these.
 * Keeping the handlers as pure functions over an injected dep bag means the
 * tests can construct fakes for the source / config / paths without touching
 * Electron at all.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  UpdateApplyReq,
  UpdateCheckReq,
  UpdateRunReq,
  type UpdateApplyResT,
  type UpdateCheckResT,
  type UpdateRunResT,
} from '@shared/ipc-types';
import type { Manifest } from '@shared/schema';
import type { PackageSource } from '@shared/source/package-source';
import type { VdxConfig } from '@shared/config/vdx-config';
import {
  applyHostUpdate,
  checkForHostUpdate,
  downloadHostUpdate,
  SELF_UPDATE_APP_ID,
} from '@main/updater';
import { fetchManifestVerified } from '@main/catalog';
import { ipcError, ipcErrorMessage } from '@main/ipc/error';

export interface UpdateHandlerDeps {
  packageSource: PackageSource;
  config: VdxConfig;
  hostVersion: string;
  cacheDir: string;
  /** Snapshot read once per call so a parallel install can race the gate cleanly. */
  activeTransactions: () => number;
  /** The trust-root union, including dev key when developerMode is on. */
  getTrustRoots: () => Promise<Uint8Array[]>;
  /**
   * Process exit hook called by `update:apply` once the staged installer
   * has been spawned. Production wires this to `app.quit()`; tests pass a spy.
   */
  quit: () => void;
  /**
   * Most recently staged version. `update:run` sets this on success;
   * `update:apply` reads it to locate the .staged file. Lives only for
   * the host process lifetime (not in installed.json) — a fresh launch
   * after a failed apply re-discovers via filesystem scan if needed.
   */
  getStagedVersion: () => string | null;
  setStagedVersion: (version: string | null) => void;
}

function selfUpdateConfigOf(config: VdxConfig): { repo: string } | null {
  return config.source.type === 'github' && config.source.github
    ? { repo: config.source.github.selfUpdateRepo }
    : null;
}

export async function handleUpdateCheck(
  deps: UpdateHandlerDeps,
  raw: unknown,
): Promise<UpdateCheckResT> {
  const parsed = UpdateCheckReq.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, error: 'invalid request' };
  try {
    const info = await checkForHostUpdate({
      source: deps.packageSource,
      selfUpdateConfig: selfUpdateConfigOf(deps.config),
      currentVersion: deps.hostVersion,
      channel: deps.config.channel,
    });
    return { ok: true, info };
  } catch (e) {
    return ipcError(e);
  }
}

export async function handleUpdateRun(
  deps: UpdateHandlerDeps,
  raw: unknown,
): Promise<UpdateRunResT> {
  const parsed = UpdateRunReq.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'invalid request' };
  if (deps.activeTransactions() > 0) {
    return {
      ok: false,
      error: 'An install is in progress. Complete or cancel it before restarting.',
    };
  }
  try {
    const info = await checkForHostUpdate({
      source: deps.packageSource,
      selfUpdateConfig: selfUpdateConfigOf(deps.config),
      currentVersion: deps.hostVersion,
      channel: deps.config.channel,
    });
    if (!info) return { ok: false, error: 'No update available' };

    // Verify the host-installer manifest through the trust-root chain so the
    // SHA-256 we hand to downloadHostUpdate is signed — never user-supplied.
    let updateManifest: Manifest;
    try {
      updateManifest = await fetchManifestVerified(
        deps.packageSource,
        SELF_UPDATE_APP_ID,
        info.latestVersion,
        { trustRoots: await deps.getTrustRoots() },
      );
    } catch (e) {
      return { ok: false, error: `Update manifest verify failed: ${ipcErrorMessage(e)}` };
    }

    const destPath = join(deps.cacheDir, `vdx-installer-${info.latestVersion}.staged`);
    await downloadHostUpdate(info, {
      source: deps.packageSource,
      destPath,
      expectedSha256: updateManifest.payload.sha256,
    });

    // Record the staged version so update:apply can find the file. Renderer
    // surfaces a "Restart to apply" badge after this resolves.
    deps.setStagedVersion(info.latestVersion);
    return { ok: true };
  } catch (e) {
    return ipcError(e);
  }
}

/**
 * Apply the previously-staged update — run the NSIS upgrade silently and
 * quit the host so the new installer can replace files in place.
 *
 * Refuses if no staged version is on record (the renderer should hide the
 * Restart button in that case anyway, but we still gate server-side so a
 * stale window can't accidentally relaunch). Refuses if a transaction is
 * mid-flight, same as `update:run`.
 */
export async function handleUpdateApply(
  deps: UpdateHandlerDeps,
  raw: unknown,
): Promise<UpdateApplyResT> {
  const parsed = UpdateApplyReq.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'invalid request' };
  if (deps.activeTransactions() > 0) {
    return {
      ok: false,
      error: 'An install is in progress. Complete or cancel it before restarting.',
    };
  }
  const stagedVersion = deps.getStagedVersion();
  if (!stagedVersion) {
    return { ok: false, error: 'No staged update — run update:run first.' };
  }
  const stagedPath = join(deps.cacheDir, `vdx-installer-${stagedVersion}.staged`);
  if (!existsSync(stagedPath)) {
    // Stale state — clear it so the renderer hides the badge.
    deps.setStagedVersion(null);
    return { ok: false, error: `Staged installer missing on disk: ${stagedPath}` };
  }
  const result = await applyHostUpdate({
    stagedPath,
    onQuit: deps.quit,
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true };
}
