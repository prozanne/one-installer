/**
 * Built-in fallback defaults — used ONLY when no vdx.config.json is found.
 *
 * These are the ONLY place in the codebase where "samsung/vdx-catalog" and
 * related strings appear. All other code reads from the loaded VdxConfig.
 *
 * Only fields whose values cannot come from a zod .default() live here.
 * `channel`, `telemetry`, `developerMode` are filled in by the schema's
 * .default() clauses when this object is parsed via VdxConfigSchema.parse().
 *
 * NO operator data baked in — these are FALLBACK defaults only.
 *
 * @see docs/superpowers/specs/2026-05-01-package-source-abstraction.md §6.2
 */
export const BUILTIN_DEFAULT_CONFIG = {
  schemaVersion: 1 as const,
  source: {
    type: 'github' as const,
    github: {
      catalogRepo: 'samsung/vdx-catalog',
      selfUpdateRepo: 'samsung/vdx-installer',
      appsOrg: 'samsung',
      apiBase: 'https://api.github.com',
      ref: 'stable',
    },
  },
} as const;
