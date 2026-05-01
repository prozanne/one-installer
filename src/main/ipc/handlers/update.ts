/**
 * Pure update IPC handlers — extracted from `electron-main.ts`.
 *
 * The skipped tests in `test/ipc/handlers-update.test.ts` exist for these.
 * Keeping the handlers as pure functions over an injected dep bag means the
 * tests can construct fakes for the source / config / paths without touching
 * Electron at all.
 */
import { join } from 'node:path';
import {
  UpdateCheckReq,
  UpdateRunReq,
  type UpdateCheckResT,
  type UpdateRunResT,
} from '@shared/ipc-types';
import type { Manifest } from '@shared/schema';
import type { PackageSource } from '@shared/source/package-source';
import type { VdxConfig } from '@shared/config/vdx-config';
import {
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

    // Phase 1.2 will add Authenticode verify + replace-on-restart here. Until
    // then the staged file just sits in cache; nothing relaunches.
    return { ok: true };
  } catch (e) {
    return ipcError(e);
  }
}
