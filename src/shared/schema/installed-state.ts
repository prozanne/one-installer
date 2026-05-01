import { z } from 'zod';
import { JournalEntry } from './journal';
import { ManifestSchema } from './manifest';

const Settings = z.object({
  language: z.string(),
  updateChannel: z.enum(['stable', 'beta', 'internal']),
  autoUpdateHost: z.enum(['auto', 'ask', 'manual']),
  autoUpdateApps: z.enum(['auto', 'ask', 'manual']),
  cacheLimitGb: z.number().int().positive(),
  proxy: z
    .object({ host: z.string(), port: z.number().int(), auth: z.string().nullable() })
    .nullable(),
  telemetry: z.boolean(),
  trayMode: z.boolean(),
  developerMode: z.boolean(),
});

const InstalledApp = z.object({
  version: z.string(),
  installScope: z.enum(['user', 'machine']),
  installPath: z.string(),
  wizardAnswers: z.record(z.string(), z.unknown()),
  journal: z.array(JournalEntry),
  manifestSnapshot: ManifestSchema,
  installedAt: z.string().datetime(),
  updateChannel: z.enum(['stable', 'beta', 'internal']),
  autoUpdate: z.enum(['auto', 'ask', 'manual']),
  source: z.enum(['catalog', 'sideload']).default('catalog'),
  /**
   * Which catalog this entry belongs to. Used purely for grouping in the
   * UI's tabs (Apps / Agents). Defaults to 'app' so existing installations
   * recorded before this field existed continue to surface under the Apps
   * tab without a migration step.
   */
  kind: z.enum(['app', 'agent']).default('app'),
});

// Intentionally NOT `.strict()`. This schema is for state we wrote ourselves
// (host's own installed.json). A future host version might add fields a
// reader on the older build doesn't know about; if we strict-reject those,
// `installed-store.read()` falls through to .bak (which carries the same
// forward-compat shape and ALSO rejects), then to `defaults()` — silently
// wiping the user's install registry. Strip-unknown is the right default
// for "we own this data" schemas; strict is reserved for external input
// (Manifest, Catalog, vdx.config.json).
export const InstalledStateSchema = z.object({
  schema: z.literal(1),
  host: z.object({ version: z.string() }),
  lastCatalogSync: z.string().datetime().nullable(),
  settings: Settings,
  apps: z.record(z.string(), InstalledApp),
});

export type InstalledStateT = z.infer<typeof InstalledStateSchema>;
export type InstalledAppT = z.infer<typeof InstalledApp>;
export type SettingsT = z.infer<typeof Settings>;
