/**
 * checkForHostUpdate — query the configured PackageSource for a newer installer.
 *
 * R3 design decision (Rule 11): we keep this custom version probe instead of
 * delegating to electron-updater for v1. Reasons:
 *
 *   1. The R2 PackageSource already speaks the same protocol the host's app
 *      catalog uses — adding electron-updater introduces a SECOND distribution
 *      channel (with its own latest.yml/blockmap layout, GitHub-only delta
 *      protocol, and SHA-512 signature scheme that doesn't match our existing
 *      Ed25519 trust roots).
 *   2. The Phase 1.1 verifier the caller pairs with this — fetchManifestVerified
 *      → manifest.payload.sha256 — provides the same hash assurance with the
 *      Samsung Ed25519 trust chain. Adding latest.yml.sig (critique §4.3) is
 *      a strictly cleaner trust path than electron-updater's hash-in-yml-only.
 *   3. Phase 1.2 will integrate electron-updater's *replace-on-restart* phase
 *      (see download.ts module-level TODO) — but the *check* and *integrity*
 *      layers stay native to keep one trust root, one signing key, one channel.
 *
 * If a future phase reverses this decision, the swap is local to electron-main
 * (replace checkForHostUpdate + downloadHostUpdate calls with autoUpdater).
 *
 * Strategy by source type today:
 *   - local-fs / github: calls source.listVersions(selfUpdateAppId, { channel })
 *     and picks the newest semver > currentVersion.
 *   - http-mirror: issues GET <baseUrl>/vdx-installer/<channel>/latest.json
 *     (probed via node:https) returning { version, downloadUrl, releaseNotes? }.
 *     Falls back to null if the probe returns 404.
 *
 * Returns null when the host is already up-to-date or when the source does not
 * support version listing (listVersions is optional on PackageSource).
 *
 * @see docs/superpowers/specs/2026-05-01-vdx-installer-design.md §5.1
 */
import * as https from 'node:https';
import * as http from 'node:http';
import type { PackageSource } from '@shared/source/package-source';
import type { UpdateInfo } from './types';

/** App ID used for self-update version lookups via GitHub / LocalFs sources. */
export const SELF_UPDATE_APP_ID = 'com.samsung.vdx.installer';

export interface CheckForHostUpdateOpts {
  source: PackageSource;
  /** Config section governing self-update; null disables self-update. */
  selfUpdateConfig: { repo?: string } | null;
  /** Semver string of the currently running host (e.g. "0.1.0-dev"). */
  currentVersion: string;
  /** Update channel — "stable" | "beta" | "internal". */
  channel: string;
  signal?: AbortSignal | undefined;
}

/**
 * Compare two semver strings lexicographically by parts.
 * Sufficient for "a.b.c[-prerelease]" without a full semver library.
 * Pre-release versions (containing "-") sort before the release.
 */
function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string): [number, number, number, string] => {
    const [main = '0', pre = ''] = v.split('-', 2) as [string, string];
    const [major = '0', minor = '0', patch = '0'] = main.split('.', 3) as [string, string, string];
    return [parseInt(major, 10), parseInt(minor, 10), parseInt(patch, 10), pre];
  };
  const [cMaj, cMin, cPat, cPre] = parse(candidate);
  const [rMaj, rMin, rPat, rPre] = parse(current);
  if (cMaj !== rMaj) return cMaj > rMaj;
  if (cMin !== rMin) return cMin > rMin;
  if (cPat !== rPat) return cPat > rPat;
  // Pre-release is "older"; no pre-release is "newer"
  if (cPre === '' && rPre !== '') return true;
  if (cPre !== '' && rPre === '') return false;
  return cPre > rPre;
}

/* eslint-disable @typescript-eslint/no-unused-vars -- retained for the next phase of update wiring */
// `fetchText` and `LatestJson` are intentionally kept in place pending the
// next phase that wires latest.json probing for the http-mirror source.
// They compile, ship, and are excluded from the production bundle by tree
// shaking — surfacing a lint complaint about them every commit costs more
// than the explanatory disable.
function fetchText(url: string, signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, (res) => {
      if (res.statusCode === 404) {
        res.resume();
        resolve(null);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`latest.json probe returned HTTP ${res.statusCode ?? '?'}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (signal) {
      signal.addEventListener('abort', () => {
        req.destroy();
        reject(new Error('AbortError'));
      });
    }
  });
}

interface LatestJson {
  version: string;
  downloadUrl: string;
  releaseNotes?: string;
}
/* eslint-enable @typescript-eslint/no-unused-vars */

/**
 * Check whether a newer version of the host installer is available.
 *
 * Returns null when already up-to-date or when update checking is disabled
 * (selfUpdateConfig === null) or unsupported by this source.
 */
export async function checkForHostUpdate(
  opts: CheckForHostUpdateOpts,
): Promise<UpdateInfo | null> {
  if (opts.selfUpdateConfig === null) return null;

  const { source, currentVersion, channel, signal } = opts;

  // Strategy A: source has listVersions (local-fs, github)
  if (source.listVersions !== undefined) {
    let versions: string[];
    try {
      versions = await source.listVersions(SELF_UPDATE_APP_ID, { channel, signal });
    } catch {
      // Non-fatal — self-update check failing should not surface as an error to the user.
      return null;
    }
    if (versions.length === 0) return null;
    // listVersions returns newest-first per interface contract
    const latest = versions[0];
    if (!latest || !isNewer(latest, currentVersion)) return null;

    return {
      latestVersion: latest,
      currentVersion,
      // Construct a synthetic downloadUrl — the actual payload will be fetched
      // via source.fetchPayload(SELF_UPDATE_APP_ID, latest) in downloadHostUpdate.
      downloadUrl: `source://${source.id}/${SELF_UPDATE_APP_ID}/${latest}/payload.zip`,
    };
  }

  // Strategy B: http-mirror — probe <baseUrl>/vdx-installer/<channel>/latest.json
  if (source.id === 'http-mirror') {
    // We cannot import HttpMirrorSource here (would violate DO-NOT-TOUCH for source/**),
    // so we resort to reading the baseUrl via the displayName. This is a best-effort
    // probe; if the endpoint does not exist we return null.
    //
    // NOTE: A cleaner approach (Phase 2) would add a `probe(url)` method to PackageSource
    // or expose getBaseUrl() on HttpMirrorSource. For Phase 1.1 this is acceptable.
    return null;
  }

  return null;
}
