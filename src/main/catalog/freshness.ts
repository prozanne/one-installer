/**
 * Catalog signature replay defense.
 *
 * A signed catalog body remains cryptographically valid forever. An attacker
 * sitting between the host and the source (or with disk-write to a local
 * mirror) can re-serve an old, signed catalog whose entries have since been
 * deprecated/removed for security reasons. The `updatedAt` field inside the
 * catalog body is signed alongside everything else, so we can use it as a
 * monotonic freshness anchor: never accept a catalog whose `updatedAt` is
 * older than the highest one we've already seen for that kind.
 *
 * The anchor is stored in `installed.json` under `catalogFreshness[kind]` and
 * surfaces here as a small pure helper.
 */
import type { InstalledStateT } from '@shared/schema';
import type { CatalogKindT } from '@shared/ipc-types';

/**
 * Operators occasionally re-issue a catalog with a slightly-earlier
 * `updatedAt` due to clock-skew or build-system retries. 60 s grace lets
 * those through without papering over real replays.
 */
export const FRESHNESS_SKEW_MS = 60_000;

export interface FreshnessCheck {
  ok: boolean;
  /** When `ok === false`, a human-readable reason. */
  reason?: string;
}

/**
 * Compare an incoming catalog's `updatedAt` against the stored anchor.
 * Returns ok:true if the incoming is at least as fresh (modulo skew), else
 * ok:false with a reason the caller can surface to the user / log.
 */
export function checkCatalogFreshness(
  incomingUpdatedAt: string,
  anchor: string | undefined,
  now: number = Date.now(),
): FreshnessCheck {
  if (!anchor) return { ok: true };
  const incoming = Date.parse(incomingUpdatedAt);
  const stored = Date.parse(anchor);
  if (!Number.isFinite(incoming) || !Number.isFinite(stored)) {
    // If either timestamp is malformed, refuse — the catalog body is wrong
    // shape, which a signature shouldn't have admitted anyway.
    return { ok: false, reason: 'Invalid updatedAt timestamp' };
  }
  if (incoming + FRESHNESS_SKEW_MS < stored) {
    const incomingDate = new Date(incoming).toISOString();
    const storedDate = new Date(stored).toISOString();
    return {
      ok: false,
      reason: `Catalog appears to be a replay: incoming updatedAt=${incomingDate} is older than stored anchor=${storedDate} (skew=${FRESHNESS_SKEW_MS}ms)`,
    };
  }
  // Future timestamps are weird but not a replay; let the caller decide whether
  // to clamp. (`now` is unused for monotonicity but kept in signature so a
  // future "reject too-far-future" rule has a clean place to land.)
  void now;
  return { ok: true };
}

/**
 * Read the stored anchor for a given kind out of the InstalledState shape.
 * Returns undefined when never set or when the field is missing entirely
 * (older builds that wrote installed.json without `catalogFreshness`).
 */
export function getFreshnessAnchor(
  state: InstalledStateT,
  kind: CatalogKindT,
): string | undefined {
  return state.catalogFreshness?.[kind];
}
