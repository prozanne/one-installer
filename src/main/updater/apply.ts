/**
 * applyHostUpdate — Phase 1.2 replace-on-restart for the host installer.
 *
 * The handoff from Phase 1.1 is a `.staged` file at
 * `<cacheDir>/vdx-installer-<version>.staged` whose SHA-256 has already been
 * verified against a signed manifest (see download.ts). All `applyHostUpdate`
 * does is:
 *
 *   1. (Windows only, best-effort) verify the staged file's Authenticode
 *      signature via PowerShell `Get-AuthenticodeSignature`. The host EXE
 *      itself must be EV-signed for SmartScreen reputation; we want the
 *      same gate before we let it overwrite us.
 *   2. Spawn the staged installer with NSIS silent-upgrade flags, detached,
 *      so it survives the host process exiting.
 *   3. Call `app.quit()`. NSIS waits for the host to exit, replaces files
 *      in place, and re-launches the new host.
 *
 * No `MoveFileEx + DELAY_UNTIL_REBOOT` fallback in v1 — the user already
 * implicitly consented to a relaunch by clicking "Restart now". The reboot-
 * delay path is reserved for the corner case where the NSIS installer
 * itself can't proceed (e.g. user cancels UAC), in which case we surface
 * the error and leave the staged file in cache for next attempt.
 *
 * On non-Windows (dev on macOS, CI on Linux) this is a no-op that returns
 * `{ ok: false, error: 'unsupported-platform' }` so the IPC handler can
 * report cleanly.
 *
 * @see docs/superpowers/specs/2026-05-01-vdx-installer-design.md §5.1
 */
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';

const execFileP = promisify(execFile);

export interface ApplyHostUpdateOpts {
  /** Absolute path to the verified staged installer EXE. */
  stagedPath: string;
  /**
   * Process exit hook. Called after the staged installer is spawned;
   * production passes `() => app.quit()`. Tests pass a spy.
   */
  onQuit: () => void;
  /**
   * Strict Authenticode check toggle. Defaults to true on win32. Tests pass
   * `false` so the spawn path can run without a real signed EXE.
   */
  verifyAuthenticode?: boolean;
  /**
   * Override the platform string. Tests pass 'win32' / 'darwin' to exercise
   * both branches without monkey-patching `process.platform`.
   */
  platform?: NodeJS.Platform;
  /**
   * Override the spawn function. Tests pass a fake; production omits.
   */
  spawnFn?: typeof spawn;
}

export type ApplyHostUpdateResult =
  | { ok: true }
  | { ok: false; error: string; code: 'missing-staged' | 'sig-invalid' | 'unsupported-platform' | 'spawn-failed' };

export async function applyHostUpdate(opts: ApplyHostUpdateOpts): Promise<ApplyHostUpdateResult> {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') {
    return { ok: false, error: `applyHostUpdate not supported on ${platform}`, code: 'unsupported-platform' };
  }
  if (!existsSync(opts.stagedPath)) {
    return { ok: false, error: `Staged installer missing: ${opts.stagedPath}`, code: 'missing-staged' };
  }
  // Sanity: refuse to spawn an empty file. NSIS would silently no-op and
  // we'd quit the host into a broken state.
  if (statSync(opts.stagedPath).size < 1024) {
    return { ok: false, error: 'Staged installer too small', code: 'missing-staged' };
  }

  const verify = opts.verifyAuthenticode ?? true;
  if (verify) {
    const sigOk = await verifyAuthenticodeSignature(opts.stagedPath);
    if (!sigOk.ok) {
      return { ok: false, error: `Authenticode verify failed: ${sigOk.error}`, code: 'sig-invalid' };
    }
  }

  // NSIS silent upgrade flags. `/S` runs in silent mode (no UAC prompt
  // beyond the elevation request, no progress UI). The new installer
  // detects an existing install via the ARP entry and overwrites in place.
  // `--updated` is a custom hint we read on relaunch to render a
  // "Updated to vN.N.N" toast on first paint after upgrade.
  const args = ['/S', '--updated'];
  const spawnFn = opts.spawnFn ?? spawn;
  try {
    const child = spawnFn(opts.stagedPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (e) {
    return { ok: false, error: `spawn failed: ${(e as Error).message}`, code: 'spawn-failed' };
  }

  // Hand off control. The new installer waits for our process tree to exit
  // before replacing files, so quitting promptly is part of the protocol.
  opts.onQuit();
  return { ok: true };
}

/**
 * Verify the Authenticode signature on a Windows EXE. Best-effort only —
 * we shell out to PowerShell because the alternative (a native node module
 * binding `WinVerifyTrust`) brings a transitive C++ dep we'd rather avoid
 * in v1.
 *
 * Returns ok when PowerShell reports `Status -eq 'Valid'`. Anything else
 * (NotSigned / HashMismatch / NotTrusted) is rejected.
 */
async function verifyAuthenticodeSignature(
  exePath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Single PS round-trip, ASCII-only output to avoid stdout encoding
  // surprises on legacy code pages.
  const ps = `(Get-AuthenticodeSignature -FilePath '${exePath.replace(/'/g, "''")}').Status`;
  try {
    const { stdout } = await execFileP(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: 30_000 },
    );
    const status = (typeof stdout === 'string' ? stdout : Buffer.from(stdout as ArrayBufferLike).toString('utf8')).trim();
    if (status === 'Valid') return { ok: true };
    return { ok: false, error: `signature status: ${status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
