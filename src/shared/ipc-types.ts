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
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  diagExport: 'diag:export',
  diagOpenLogs: 'diag:open-logs',
  updateCheck: 'update:check',
  updateRun: 'update:run',
  updateApply: 'update:apply',
  updateAvailable: 'update:available',
  appsCheckUpdates: 'apps:checkUpdates',
  appsUpdateRun: 'apps:updateRun',
  appsUpdatesAvailable: 'apps:updatesAvailable',
  authSetToken: 'auth:setToken',
  authClearToken: 'auth:clearToken',
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
  phase: z.enum([
    'download',
    'verify',
    'extract',
    'actions',
    'arp',
    'commit',
    'rollback',
    'done',
    'error',
  ]),
  message: z.string(),
  percent: z.number().min(0).max(100).optional(),
  /** Bytes downloaded so far, set during the 'download' phase. */
  downloadedBytes: z.number().nonnegative().optional(),
  /** Total bytes of the asset being downloaded; absent when Content-Length not known. */
  totalBytes: z.number().nonnegative().optional(),
  /** Instantaneous download speed in bytes/sec, set during the 'download' phase. */
  bytesPerSec: z.number().nonnegative().optional(),
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

// ---------------------------------------------------------------------------
// Settings IPC
// ---------------------------------------------------------------------------

const SettingsSchema = InstalledStateSchema.shape.settings;
export type Settings = z.infer<typeof SettingsSchema>;

export const SettingsGetReq = z.object({
  key: SettingsSchema.keyof().optional(),
});
export const SettingsGetRes = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), settings: SettingsSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export const SettingsSetReq = z.object({
  patch: SettingsSchema.partial(),
});
export const SettingsSetRes = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), settings: SettingsSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export type SettingsGetReqT = z.infer<typeof SettingsGetReq>;
export type SettingsGetResT = z.infer<typeof SettingsGetRes>;
export type SettingsSetReqT = z.infer<typeof SettingsSetReq>;
export type SettingsSetResT = z.infer<typeof SettingsSetRes>;

// ---------------------------------------------------------------------------
// Diagnostics IPC
// ---------------------------------------------------------------------------

export const DiagExportReq = z.object({});
// Path-free response: main writes the archive and reveals it via
// shell.showItemInFolder; the renderer never learns the host filesystem
// layout. (Critique F-09 / Rule 10.)
export const DiagExportRes = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

// No payload: main always opens its own paths.logsDir. Accepting a renderer-
// supplied path would let any compromised UI ask the OS to open arbitrary
// directories. (Critique F-09 / Rule 10.)
export const DiagOpenLogsReq = z.object({});
export const DiagOpenLogsRes = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export type DiagExportReqT = z.infer<typeof DiagExportReq>;
export type DiagExportResT = z.infer<typeof DiagExportRes>;
export type DiagOpenLogsReqT = z.infer<typeof DiagOpenLogsReq>;
export type DiagOpenLogsResT = z.infer<typeof DiagOpenLogsRes>;

// ---------------------------------------------------------------------------
// Self-update IPC
// ---------------------------------------------------------------------------

const UpdateInfoSchema = z.object({
  latestVersion: z.string(),
  currentVersion: z.string(),
  downloadUrl: z.string().url(),
  releaseNotes: z.string().optional(),
});

export const UpdateCheckReq = z.object({});
export const UpdateCheckRes = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), info: UpdateInfoSchema.nullable() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export const UpdateRunReq = z.object({ confirm: z.literal(true) });
export const UpdateRunRes = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

/**
 * Apply the previously-staged update — relaunch into the new installer.
 * Distinct from UpdateRun (which only downloads) so a user can stage an
 * update at one time and decide to restart later. The renderer only
 * surfaces this button after a successful UpdateRun.
 */
export const UpdateApplyReq = z.object({ confirm: z.literal(true) });
export const UpdateApplyRes = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

/**
 * Server-pushed event broadcast when a background poll detected a new
 * host version. Fields mirror UpdateInfo so the renderer can render the
 * version + release notes without a follow-up `update:check` round-trip.
 * Sent only on transitions (no version → some version, or upward semver
 * change) so the renderer doesn't get spammed.
 */
export const UpdateAvailableEvent = UpdateInfoSchema;

export type UpdateCheckReqT = z.infer<typeof UpdateCheckReq>;
export type UpdateCheckResT = z.infer<typeof UpdateCheckRes>;
export type UpdateApplyReqT = z.infer<typeof UpdateApplyReq>;
export type UpdateApplyResT = z.infer<typeof UpdateApplyRes>;
export type UpdateAvailableEventT = z.infer<typeof UpdateAvailableEvent>;
export type UpdateInfoT = z.infer<typeof UpdateInfoSchema>;
export type UpdateRunReqT = z.infer<typeof UpdateRunReq>;
export type UpdateRunResT = z.infer<typeof UpdateRunRes>;

// ---------------------------------------------------------------------------
// Auth IPC — first-run PAT flow (design spec §13.2). Tokens are stored at the
// OS layer via Electron safeStorage; the response NEVER echoes the token, not
// even a prefix or length. The renderer's job is to forget the value as soon
// as the IPC call returns.
// ---------------------------------------------------------------------------

export const AuthSetTokenReq = z.object({
  token: z.string().min(1).max(256),
});
export const AuthSetTokenRes = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export const AuthClearTokenReq = z.object({});
export const AuthClearTokenRes = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export type AuthSetTokenReqT = z.infer<typeof AuthSetTokenReq>;
export type AuthSetTokenResT = z.infer<typeof AuthSetTokenRes>;
export type AuthClearTokenReqT = z.infer<typeof AuthClearTokenReq>;
export type AuthClearTokenResT = z.infer<typeof AuthClearTokenRes>;

// ---------------------------------------------------------------------------
// Per-app updates (Phase 2)
// ---------------------------------------------------------------------------

const AppUpdateCandidate = z.object({
  appId: z.string(),
  fromVersion: z.string(),
  toVersion: z.string(),
  /** Display name from catalog (or installed.json fallback). */
  displayName: z.string(),
  /** 'app' | 'agent' — drives which catalog the install request is routed to. */
  kind: CatalogKindSchema,
  /** Whether the user must explicitly approve, or whether main will auto-run it. */
  policy: z.enum(['auto', 'ask', 'manual']),
});

export const AppsCheckUpdatesReq = z.object({});
export const AppsCheckUpdatesRes = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), candidates: z.array(AppUpdateCandidate) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

/**
 * Trigger an update install for a single app by id. Reuses the existing
 * catalog:install pipeline (parseVdxpkg + transactional install) but skips
 * the wizard when no new wizard step appeared since the previous install.
 *
 * - installed:true → silent path completed; renderer just refreshes apps:list.
 * - installed:false + sessionId → renderer routes to /wizard with the session,
 *   user fills the new step, then /progress as usual.
 */
export const AppsUpdateRunReq = z.object({ appId: z.string() });
export const AppsUpdateRunRes = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    installed: z.boolean(),
    sessionId: z.string().uuid().optional(),
    manifest: ManifestSchema.optional(),
    defaultInstallPath: z.string().optional(),
    signatureValid: z.boolean().optional(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

/** Broadcast on every catalog refresh that found at least one candidate. */
export const AppsUpdatesAvailableEvent = z.object({
  candidates: z.array(AppUpdateCandidate),
});

export type AppUpdateCandidateT = z.infer<typeof AppUpdateCandidate>;
export type AppsCheckUpdatesReqT = z.infer<typeof AppsCheckUpdatesReq>;
export type AppsCheckUpdatesResT = z.infer<typeof AppsCheckUpdatesRes>;
export type AppsUpdateRunReqT = z.infer<typeof AppsUpdateRunReq>;
export type AppsUpdateRunResT = z.infer<typeof AppsUpdateRunRes>;
export type AppsUpdatesAvailableEventT = z.infer<typeof AppsUpdatesAvailableEvent>;
