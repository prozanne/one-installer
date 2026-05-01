import { z } from 'zod';

const Localized = z.object({ default: z.string() }).catchall(z.string());

/**
 * One installable item visible in a catalog. The catalog is browsable —
 * the renderer must show the user *something* (name, description, version)
 * without first fetching the full per-app manifest. So display fields
 * live here, alongside the network coordinates needed to install.
 *
 * Catalogs hosted on GitHub Pages typically include a direct `packageUrl`
 * pointing to the latest `.vdxpkg`. Catalogs that prefer the GitHub
 * Releases API model can omit it and supply only `repo` — the host then
 * discovers the latest release at install time. Both are supported.
 */
const CatalogItem = z.object({
  id: z.string(),
  /** Display name; falls back through the spec's locale resolution chain. */
  displayName: Localized.optional(),
  /** Short description used in catalog cards. */
  displayDescription: Localized.optional(),
  /** Semver string of the latest release advertised by the catalog. */
  latestVersion: z.string().optional(),
  /** Optional icon URL (HTTPS). The renderer falls back to a generated initial when absent. */
  iconUrl: z.string().url().optional(),
  /** Direct URL to the latest `.vdxpkg`. Required when `repo` is absent. */
  packageUrl: z.string().url().optional(),
  /** GitHub repo coordinate `org/name`. Required when `packageUrl` is absent. */
  repo: z.string().optional(),
  category: z.string(),
  channels: z.array(z.enum(['stable', 'beta', 'internal'])).min(1),
  tags: z.array(z.string()),
  minHostVersion: z.string(),
  deprecated: z.boolean(),
  replacedBy: z.string().nullable(),
  addedAt: z.string().datetime(),
});

export const CatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    updatedAt: z.string().datetime(),
    /**
     * Optional catalog kind hint for the renderer. The host doesn't
     * actually read this — the kind is determined by which configured
     * URL the catalog was fetched from. Hint exists so a hand-written
     * catalog file can be self-describing.
     */
    kind: z.enum(['app', 'agent']).optional(),
    channels: z.array(z.enum(['stable', 'beta', 'internal'])),
    categories: z.array(z.object({ id: z.string(), label: Localized })),
    featured: z.array(z.string()),
    /**
     * Items in this catalog. The field is named `apps` for backward
     * compatibility with the original spec; for an agent catalog these
     * entries are agents. The renderer relabels them at display time.
     */
    apps: z.array(CatalogItem),
  })
  .strict()
  .refine(
    (c) => c.apps.every((a) => a.packageUrl || a.repo),
    { message: 'Each catalog item must specify either packageUrl or repo' },
  );

export type CatalogT = z.infer<typeof CatalogSchema>;
export type CatalogItemT = z.infer<typeof CatalogItem>;
