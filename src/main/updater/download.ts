/**
 * downloadHostUpdate — stream and hash-verify the updated host installer binary.
 *
 * Phase 1.1: streaming download + SHA-256 verification only.
 *
 * TODO (Phase 1.2 — Windows-specific, tracked in milestone "Phase 1.2 replace-on-restart"):
 *   1. Verify Authenticode signature on the downloaded EXE using Windows CryptoAPI
 *      (via native module or PowerShell `Get-AuthenticodeSignature`). Abort if invalid.
 *   2. Write the verified binary to a staging path (e.g. destPath + ".staged").
 *   3. Schedule replace-on-restart:
 *        app.relaunch({ execPath: stagedPath });
 *        app.quit();
 *      Or use MoveFileExW with MOVEFILE_DELAY_UNTIL_REBOOT on Windows if in-use.
 *   4. Emit a user-visible notification that the update will apply on next launch.
 *
 * @see docs/superpowers/specs/2026-05-01-vdx-installer-design.md §5.1
 */
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { PackageSource } from '@shared/source/package-source';
import type { UpdateInfo } from './types';

export interface DownloadHostUpdateOpts {
  source: PackageSource;
  /** Absolute path to write the downloaded payload. */
  destPath: string;
  /** Expected lowercase hex SHA-256 of the payload (or "sha256:<hex>" prefix). */
  expectedSha256: string;
  signal?: AbortSignal | undefined;
}

/**
 * Parse the synthetic source:// URL produced by checkForHostUpdate back into
 * (appId, version) parts so we can call source.fetchPayload.
 * URL shape: source://<sourceId>/<appId>/<version>/payload.zip
 */
function parseSyntheticUrl(url: string): { appId: string; version: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'source:') return null;
    // pathname: /<appId>/<version>/payload.zip
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 3) return null;
    const version = parts[parts.length - 2];
    const appId = parts.slice(0, parts.length - 2).join('/');
    if (!appId || !version) return null;
    return { appId, version };
  } catch {
    return null;
  }
}

/**
 * Stream the updated installer from the source, writing to destPath while
 * computing SHA-256 inline. Throws if the hash does not match expectedSha256.
 *
 * For Phase 1.1 the caller is responsible for scheduling a restart after this
 * resolves — see the TODO block at the top of this file for Phase 1.2 steps.
 */
export async function downloadHostUpdate(
  info: UpdateInfo,
  opts: DownloadHostUpdateOpts,
): Promise<void> {
  const normalized = opts.expectedSha256.startsWith('sha256:')
    ? opts.expectedSha256.slice('sha256:'.length)
    : opts.expectedSha256;

  // Resolve (appId, version) from the synthetic URL.
  const coords = parseSyntheticUrl(info.downloadUrl);
  if (!coords) {
    throw new Error(
      `downloadHostUpdate: cannot parse downloadUrl "${info.downloadUrl}". ` +
        `Expected source://<id>/<appId>/<version>/payload.zip format.`,
    );
  }

  // Ensure parent directory exists. In production cacheDir is mkdir'd at
  // startup, but if a caller passes a nested destPath (or cacheDir is wiped
  // mid-session) the createWriteStream would otherwise ENOENT.
  await mkdir(dirname(opts.destPath), { recursive: true });

  const hasher = createHash('sha256');
  // mode 0o600 — only the owner may read or replace the staged update binary.
  // Without this the file inherits umask defaults (typically 0o644 on POSIX),
  // and on a multi-user host another local account could swap in their own
  // bytes between download and the eventual replace-on-restart step.
  const writer = createWriteStream(opts.destPath, { mode: 0o600 });

  const iterable = opts.source.fetchPayload(coords.appId, coords.version, {
    signal: opts.signal,
  });

  await new Promise<void>((resolve, reject) => {
    writer.on('error', reject);
    writer.on('finish', resolve);

    void (async () => {
      try {
        for await (const chunk of iterable) {
          hasher.update(chunk);
          const ok = writer.write(chunk);
          if (!ok) {
            // Respect backpressure
            await new Promise<void>((r) => writer.once('drain', r));
          }
        }
        writer.end();
      } catch (e) {
        writer.destroy(e instanceof Error ? e : new Error(String(e)));
        reject(e);
      }
    })();
  });

  const actualHash = hasher.digest('hex');
  if (actualHash !== normalized) {
    throw new Error(
      `Host update hash mismatch: expected ${normalized}, got ${actualHash}. ` +
        `The downloaded file has been written to ${opts.destPath} but should be deleted.`,
    );
  }

  // TODO (Phase 1.2): Authenticode verification + replace-on-restart sequence.
  // See module-level TODO comment for the full sequence.
}
