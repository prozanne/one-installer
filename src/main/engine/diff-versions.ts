/**
 * diff-versions — compute per-installed-app update candidates.
 *
 * Pure function over (installed.json apps, catalog items, channel) →
 * UpdateCandidate[]. Knows nothing about IPC, network, or installation —
 * the caller decides what to do with each candidate (auto-install, surface
 * in UI, ignore).
 *
 * Comparison rules:
 *   - Only items present in BOTH installed and catalog are candidates;
 *     sideloaded apps with no catalog twin are skipped.
 *   - Item must be in the resolved channel; deprecated items are skipped
 *     (with no `replacedBy` chase yet — that's Phase 2.5).
 *   - latestVersion must be a strict semver-greater than the installed
 *     version. Equal-or-lower versions yield no candidate.
 */
import type { InstalledStateT, CatalogItemT } from '@shared/schema';

export interface UpdateCandidate {
  appId: string;
  /** Currently installed semver. */
  fromVersion: string;
  /** Catalog's advertised latest semver. */
  toVersion: string;
  /** The catalog entry — caller may need its packageUrl / repo. */
  item: CatalogItemT;
  /** What the InstalledApp policy says for this app: 'auto' | 'ask' | 'manual'. */
  policy: 'auto' | 'ask' | 'manual';
  /** 'app' or 'agent' from the InstalledApp. Used to route the install via the right flow. */
  kind: 'app' | 'agent';
}

export interface DiffInput {
  /** Result of installedStore.read().apps. */
  installed: InstalledStateT['apps'];
  /** Loaded catalog items (one kind at a time — call twice for app + agent). */
  catalogItems: readonly CatalogItemT[];
  /** Active channel — items not in this channel list are skipped. */
  channel: 'stable' | 'beta' | 'internal';
}

/**
 * Compare two semvers — returns >0 if a>b, <0 if a<b, 0 equal.
 * Tolerant of pre-release suffixes by treating them as lower-than-non-pre.
 * Avoids pulling in `semver` npm dep — manifests' SEMVER_REGEX already
 * gates input shape so we can split on dots safely.
 */
export function compareSemver(a: string, b: string): number {
  const [aMain, aPre] = a.split('-', 2);
  const [bMain, bPre] = b.split('-', 2);
  const ap = (aMain ?? '').split('.').map((n) => parseInt(n, 10));
  const bp = (bMain ?? '').split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const av = ap[i] ?? 0;
    const bv = bp[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  // Same numeric core → pre-release rules: any pre-release < no pre-release.
  if (!aPre && bPre) return 1;
  if (aPre && !bPre) return -1;
  if (aPre && bPre) return aPre < bPre ? -1 : aPre > bPre ? 1 : 0;
  return 0;
}

export function diffInstalledVsCatalog(input: DiffInput): UpdateCandidate[] {
  const candidates: UpdateCandidate[] = [];
  for (const [appId, installed] of Object.entries(input.installed)) {
    const item = input.catalogItems.find((c) => c.id === appId);
    if (!item) continue;
    if (item.deprecated) continue;
    if (!item.channels.includes(input.channel)) continue;
    if (!item.latestVersion) continue;
    if (compareSemver(item.latestVersion, installed.version) <= 0) continue;
    candidates.push({
      appId,
      fromVersion: installed.version,
      toVersion: item.latestVersion,
      item,
      policy: installed.autoUpdate,
      kind: installed.kind,
    });
  }
  return candidates;
}
