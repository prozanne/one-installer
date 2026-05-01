/**
 * Resolve the set of trust roots active for a given timestamp.
 *
 * The vdx.config.json `trustRoots` array accepts both a bare base64 pubkey
 * (legacy / simple) and an object form `{ key, keyId?, notBefore?, notAfter? }`
 * that carries validity bounds. This helper folds both forms into a flat
 * `Uint8Array[]` and drops any object-form entry whose validity window has
 * not yet opened or has already closed.
 *
 * Pure module — used by the catalog/manifest verify paths so the same key
 * filter applies everywhere a signature is checked.
 */
import type { VdxConfig } from '@shared/config/vdx-config';

export interface ResolveTrustRootsOpts {
  /** ISO timestamp the catalog claims as `updatedAt`. */
  asOf?: string | Date;
  /** Whether to also include the per-device dev keypair (host generates one
   *  for unpacked / developerMode builds). The caller computes whether to
   *  include it; we just append the bytes when truthy. */
  devPubKey?: Uint8Array | null;
}

function inWindow(
  notBefore: string | undefined,
  notAfter: string | undefined,
  asOfMs: number,
): boolean {
  if (notBefore && Date.parse(notBefore) > asOfMs) return false;
  if (notAfter && Date.parse(notAfter) < asOfMs) return false;
  return true;
}

/**
 * Build the active trust-root list. Objects with closed validity windows
 * are silently dropped — the caller doesn't need to know which key was
 * retired, only which ones currently sign anything.
 */
export function resolveTrustRoots(
  config: VdxConfig,
  opts: ResolveTrustRootsOpts = {},
): Uint8Array[] {
  const asOfMs = (() => {
    if (opts.asOf instanceof Date) return opts.asOf.getTime();
    if (typeof opts.asOf === 'string') {
      const t = Date.parse(opts.asOf);
      return Number.isFinite(t) ? t : Date.now();
    }
    return Date.now();
  })();

  const out: Uint8Array[] = [];
  for (const entry of config.trustRoots ?? []) {
    if (typeof entry === 'string') {
      out.push(Buffer.from(entry, 'base64'));
      continue;
    }
    if (!inWindow(entry.notBefore, entry.notAfter, asOfMs)) continue;
    out.push(Buffer.from(entry.key, 'base64'));
  }
  if (opts.devPubKey) out.push(opts.devPubKey);
  return out;
}
