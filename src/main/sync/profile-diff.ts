/**
 * profile-diff — pure diff between a SyncProfile and installed.json.
 *
 * Three drift categories:
 *   - missing  → profile names an app the host doesn't have
 *   - outdated → installed but a different/older version than the profile pins
 *   - extra    → installed but absent from the profile (only relevant when
 *                `removeUnlisted: true`)
 *
 * Sideloaded apps (`source: 'sideload'`) are NEVER classified as `extra` —
 * we don't yank apps the user manually installed via .vdxpkg. They CAN
 * appear as `outdated` if the profile happens to pin the same id; the
 * reconcile decides what to do with that case.
 *
 * Catalog matching: a profile entry's (id, kind) pair must locate a catalog
 * item. Without one, the entry is `missing` but flagged
 * `unresolvable: true` — the caller logs but can't act.
 */
import type { CatalogItemT, CatalogT, InstalledStateT, SyncProfileT } from '@shared/schema';
import { compareSemver } from '@main/engine/diff-versions';

export interface ProfileDriftMissing {
  kind: 'missing';
  /** Profile entry that's not installed. */
  profileApp: SyncProfileT['apps'][number];
  /** The catalog item the entry resolved to. Null when the catalog has no such id. */
  catalogItem: CatalogItemT | null;
  /** True iff catalogItem is null — caller cannot install this without operator action. */
  unresolvable: boolean;
}

export interface ProfileDriftOutdated {
  kind: 'outdated';
  profileApp: SyncProfileT['apps'][number];
  /** Currently installed semver. */
  fromVersion: string;
  /** Profile-pinned target. May be 'latest', resolved by caller via catalogItem.latestVersion. */
  toVersion: string;
  catalogItem: CatalogItemT | null;
}

export interface ProfileDriftExtra {
  kind: 'extra';
  appId: string;
  /** Installed entry — caller uses this to call uninstall. */
  installed: InstalledStateT['apps'][string];
}

export type ProfileDrift = ProfileDriftMissing | ProfileDriftOutdated | ProfileDriftExtra;

export interface DiffProfileInput {
  profile: SyncProfileT;
  /** Installed state map (installed.json#apps). */
  installed: InstalledStateT['apps'];
  /** Lookup: kind → catalog. Caller passes the cached catalogs. */
  getCatalog: (kind: 'app' | 'agent') => CatalogT | null;
}

/**
 * Compute the drift list. Pure — caller decides what to do with each entry.
 *
 * Resolution rules:
 *   - 'latest' in profile.apps[].version means "whatever the catalog
 *     advertises as latestVersion". If the catalog item has no
 *     latestVersion, treat as outdated only when *anything* newer is
 *     conceivable, which we can't determine pure-locally — so we conservatively
 *     yield no outdated entry in that case.
 *   - Pinned semver: outdated when installed.version < profile.version
 *     (semver-compare). Pinning to an older version is intentionally a no-op
 *     here — downgrades are an operator concern handled out of band.
 */
export function diffProfile(input: DiffProfileInput): ProfileDrift[] {
  const drift: ProfileDrift[] = [];
  const profileIds = new Set(input.profile.apps.map((a) => a.id));

  // Pass 1: missing / outdated by walking the profile.
  for (const entry of input.profile.apps) {
    const catalog = input.getCatalog(entry.kind);
    const catalogItem = catalog?.apps.find((c) => c.id === entry.id) ?? null;
    const installed = input.installed[entry.id];

    if (!installed) {
      drift.push({
        kind: 'missing',
        profileApp: entry,
        catalogItem,
        unresolvable: catalogItem === null,
      });
      continue;
    }

    // Skip kind mismatches — installed under a different kind tab. Treat as
    // missing for now so the operator can repair manually; we don't try to
    // auto-cross-tab-migrate.
    if (installed.kind !== entry.kind) {
      drift.push({
        kind: 'missing',
        profileApp: entry,
        catalogItem,
        unresolvable: catalogItem === null,
      });
      continue;
    }

    // Resolve target version.
    let target: string | null;
    if (entry.version === 'latest') {
      target = catalogItem?.latestVersion ?? null;
      if (!target) continue; // can't compare — leave drift empty for this entry
    } else {
      target = entry.version;
    }

    if (compareSemver(installed.version, target) < 0) {
      drift.push({
        kind: 'outdated',
        profileApp: entry,
        fromVersion: installed.version,
        toVersion: target,
        catalogItem,
      });
    }
  }

  // Pass 2: extras (only if removeUnlisted is set on the profile).
  if (input.profile.removeUnlisted) {
    for (const [appId, installed] of Object.entries(input.installed)) {
      if (profileIds.has(appId)) continue;
      // Never yank sideloaded apps automatically — those are user-chosen.
      if (installed.source === 'sideload') continue;
      drift.push({ kind: 'extra', appId, installed });
    }
  }

  return drift;
}
