/**
 * Fleet Profile Sync schema — the signed JSON declaring "this fleet of
 * machines runs these apps at these versions."
 *
 * Operator publishes a signed JSON file (alongside its detached `.sig`) at a
 * URL configured via `vdx.config.json#syncProfile`. The host periodically
 * fetches it, verifies the Ed25519 signature against the same `trustRoots`
 * union the catalog uses, diffs it against `installed.json`, and reconciles:
 *
 *   - install missing entries (delegating to catalog:install)
 *   - update outdated entries (when the profile pins a newer version)
 *   - uninstall extras (only when `removeUnlisted: true`)
 *
 * Wizard answers can be pre-canned in the profile so unattended installs on
 * fleet boxes don't block on input. Anything not specified falls through to
 * manifest defaults — the same path as a user clicking through with all
 * defaults selected.
 *
 * Distinct from the catalog: a catalog says "here is everything available";
 * a profile says "here is what should be installed on this fleet right now."
 */
import { z } from 'zod';

// CatalogKind enum is mirrored here rather than imported from
// `@shared/ipc-types` — the IPC types module imports from this folder
// (via `@shared/schema`), so a back-import would create a cycle. Both
// surfaces use the same string literals so the values stay in lockstep.
const ProfileKindEnum = z.enum(['app', 'agent']);

const ProfileApp = z
  .object({
    /** Catalog item id. Must match a `catalog.apps[].id` in the configured catalog source. */
    id: z.string().min(1).max(128),
    /** 'app' | 'agent' — selects which catalog (apps vs agents) the id is looked up in. */
    kind: ProfileKindEnum,
    /**
     * Pinned semver. The reconcile loop installs exactly this version when
     * absent, and upgrades when the installed version is older. Use 'latest'
     * to track whatever the catalog currently advertises.
     */
    version: z.union([
      z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/),
      z.literal('latest'),
    ]),
    /** Update channel hint propagated into installed-state. */
    channel: z.enum(['stable', 'beta', 'internal']).default('stable'),
    /**
     * Pre-canned wizard answers keyed by step id. Anything missing falls
     * through to manifest defaults. Same shape as `installed.json`'s
     * `wizardAnswers`.
     */
    wizardAnswers: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const SyncProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** Display name shown on the Sync tab. */
    name: z.string().min(1).max(120),
    /** Operator-controlled monotonic timestamp. Replay-defended like the catalog. */
    updatedAt: z.string().datetime(),
    /**
     * The desired install set. Order matters only for display — reconcile
     * topo-sorts implicitly by skipping already-installed items first.
     */
    apps: z.array(ProfileApp).max(256),
    /**
     * If true, any installed app NOT listed here is uninstalled on the next
     * reconcile pass. Default false for safety: an operator typo in the
     * profile shouldn't wipe users' machines. Sideloaded apps (kind:'app',
     * source:'sideload') are never removed regardless of this flag.
     */
    removeUnlisted: z.boolean().default(false),
    /** Optional, freeform — surfaced in the Sync tab as the operator's note. */
    description: z.string().max(2_000).optional(),
  })
  .strict();

export type SyncProfileT = z.infer<typeof SyncProfileSchema>;
export type SyncProfileAppT = z.infer<typeof ProfileApp>;
