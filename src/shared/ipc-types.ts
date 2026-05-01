import { z } from 'zod';
import { ManifestSchema, InstalledStateSchema, CatalogSchema } from './schema';

export const IpcChannels = {
  appsList: 'apps:list',
  sideloadOpen: 'sideload:open',
  installRun: 'install:run',
  uninstallRun: 'uninstall:run',
  installProgress: 'install:progress',
  pickVdxpkg: 'sideload:pick',
  catalogFetch: 'catalog:fetch',
  catalogInstall: 'catalog:install',
} as const;

export const CatalogKindSchema = z.enum(['app', 'agent']);
export type CatalogKindT = z.infer<typeof CatalogKindSchema>;

export const CatalogFetchReq = z.object({ kind: CatalogKindSchema });
export const CatalogFetchRes = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    catalog: CatalogSchema,
    signatureValid: z.boolean(),
    fetchedAt: z.string().datetime(),
    /** The configured URL the catalog was fetched from — surfaced for diagnostics / "edit your config" hints. */
    sourceUrl: z.string().url(),
  }),
  z.object({ ok: z.literal(false), error: z.string(), sourceUrl: z.string().url().nullable() }),
]);

export const CatalogInstallReq = z.object({
  kind: CatalogKindSchema,
  appId: z.string(),
});
/**
 * Reuses the SideloadOpenRes shape — once a catalog item's bytes are downloaded
 * and parsed, it walks the same wizard pipeline as a sideloaded `.vdxpkg`.
 * The renderer doesn't need to know whether a wizard came from sideload or
 * catalog; only the eventual installed-state entry differs (kind: 'agent').
 */
export const CatalogInstallRes = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    manifest: ManifestSchema,
    defaultInstallPath: z.string(),
    signatureValid: z.boolean(),
    sessionId: z.string().uuid(),
    kind: CatalogKindSchema,
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export const SideloadOpenReq = z.object({ vdxpkgPath: z.string() });
export const SideloadOpenRes = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    /** Manifest as already-validated JSON (parsed by main). */
    manifest: ManifestSchema,
    /** Recommended default install path (per-user) for the wizard's path step. */
    defaultInstallPath: z.string(),
    /** Whether the package signature verified against the embedded dev key. */
    signatureValid: z.boolean(),
    /** A handle the renderer passes back when running install — the main process keeps the payload bytes in memory keyed on this id. */
    sessionId: z.string().uuid(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export const InstallRunReq = z.object({
  sessionId: z.string().uuid(),
  wizardAnswers: z.record(z.string(), z.unknown()),
  /** Tag the installed-state entry. Defaults to 'app' for sideloaded packages. */
  kind: CatalogKindSchema.default('app'),
});
export const InstallRunRes = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), installPath: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export const UninstallRunReq = z.object({ appId: z.string() });
export const UninstallRunRes = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export const AppsListRes = InstalledStateSchema.shape.apps;

export const ProgressEvent = z.object({
  phase: z.enum(['extract', 'actions', 'arp', 'commit', 'rollback', 'done', 'error']),
  message: z.string(),
  percent: z.number().min(0).max(100).optional(),
});

export type SideloadOpenResT = z.infer<typeof SideloadOpenRes>;
export type InstallRunReqT = z.infer<typeof InstallRunReq>;
export type InstallRunResT = z.infer<typeof InstallRunRes>;
export type UninstallRunReqT = z.infer<typeof UninstallRunReq>;
export type UninstallRunResT = z.infer<typeof UninstallRunRes>;
export type AppsListResT = z.infer<typeof AppsListRes>;
export type ProgressEventT = z.infer<typeof ProgressEvent>;
export type CatalogFetchReqT = z.infer<typeof CatalogFetchReq>;
export type CatalogFetchResT = z.infer<typeof CatalogFetchRes>;
export type CatalogInstallReqT = z.infer<typeof CatalogInstallReq>;
export type CatalogInstallResT = z.infer<typeof CatalogInstallRes>;
