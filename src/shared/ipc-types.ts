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
  hostSetAutoLaunch: 'host:setAutoLaunch',
  hostGetAutoLaunch: 'host:getAutoLaunch',
  hostInfo: 'host:info',
  authSetToken: 'auth:setToken',
  authClearToken: 'auth:clearToken',
  syncStatus: 'sync:status',
  syncRun: 'sync:run',
  syncReport: 'sync:report',
  hostExportState: 'host:exportState',
  hostImportState: 'host:importState',
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

// ---------------------------------------------------------------------------
// Host auto-launch (start at login)
// ---------------------------------------------------------------------------

export const HostSetAutoLaunchReq = z.object({ enabled: z.boolean() });
export const HostSetAutoLaunchRes = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), enabled: z.boolean() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export const HostGetAutoLaunchReq = z.object({});
export const HostGetAutoLaunchRes = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), enabled: z.boolean(), supported: z.boolean() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export type HostSetAutoLaunchReqT = z.infer<typeof HostSetAutoLaunchReq>;
export type HostSetAutoLaunchResT = z.infer<typeof HostSetAutoLaunchRes>;
export type HostGetAutoLaunchReqT = z.infer<typeof HostGetAutoLaunchReq>;
export type HostGetAutoLaunchResT = z.infer<typeof HostGetAutoLaunchRes>;

// ---------------------------------------------------------------------------
// Host info (renderer header banner: "Connected to Linux server: my-host")
// ---------------------------------------------------------------------------

export const HostInfoReq = z.object({});
export const HostInfoRes = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    /** 'win32' | 'darwin' | 'linux' | 'freebsd' | etc. */
    platform: z.string(),
    /** 'Windows 11' | 'macOS Sonoma' | 'Ubuntu 24.04' | … — best-effort prose. */
    osLabel: z.string(),
    /** os.hostname(). Renderer renders this prominently in headless mode. */
    hostname: z.string(),
    /** Linux only: parsed /etc/os-release ID / VERSION_ID when present. */
    distro: z.string().nullable(),
    /** True iff the host was launched with `--headless` — renderer uses this to decide whether to render the "remote" banner. */
    headless: z.boolean(),
    /** Host semver (matches HOST_VERSION). */
    hostVersion: z.string(),
    /** Architecture: 'x64' | 'arm64' | … */
    arch: z.string(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export type HostInfoReqT = z.infer<typeof HostInfoReq>;
export type HostInfoResT = z.infer<typeof HostInfoRes>;

// ---------------------------------------------------------------------------
// Fleet Profile Sync IPC
//
// `sync:status` — pull the current profile, freshness, last reconcile report.
// `sync:run`    — trigger a reconcile NOW (with optional dryRun flag).
// `sync:report` — broadcast event after every reconcile (incl. background).
//
// All three are no-ops when `vdx.config.json#syncProfile` is unset; the
// renderer keys off `enabled: false` to hide the Sync tab.
// ---------------------------------------------------------------------------

const ReconcileActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('installed'), appId: z.string(), version: z.string() }),
  z.object({ kind: z.literal('updated'), appId: z.string(), fromVersion: z.string(), toVersion: z.string() }),
  z.object({ kind: z.literal('uninstalled'), appId: z.string() }),
  z.object({ kind: z.literal('skipped'), appId: z.string(), reason: z.string() }),
  z.object({ kind: z.literal('failed'), appId: z.string(), error: z.string() }),
]);

const SyncReportSchema = z.object({
  profileName: z.string(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  dryRun: z.boolean(),
  actions: z.array(ReconcileActionSchema),
});

export const SyncStatusReq = z.object({});
export const SyncStatusRes = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    /** True iff vdx.config.json#syncProfile is configured. */
    enabled: z.boolean(),
    /** Profile URL — surfaced for the operator to know which profile this fleet runs. */
    profileUrl: z.string().url().nullable(),
    /** Resolved profile name from the most recent successful fetch. Null on first run / fetch failure. */
    profileName: z.string().nullable(),
    /**
     * Timestamp of the most recent reconcile attempt (success OR failure).
     * Null if we've never run.
     */
    lastReconciledAt: z.string().datetime().nullable(),
    /** Last reconcile result — same shape as the broadcast event. Null if never run. */
    lastReport: SyncReportSchema.nullable(),
    /**
     * Whether a reconcile is currently in flight. UI uses this to disable
     * the "Sync now" button.
     */
    inFlight: z.boolean(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export const SyncRunReq = z.object({
  /** Compute drift but don't install/uninstall. Default false. */
  dryRun: z.boolean().default(false),
});
export const SyncRunRes = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), report: SyncReportSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export const SyncReportEvent = SyncReportSchema;

export type SyncStatusReqT = z.infer<typeof SyncStatusReq>;
export type SyncStatusResT = z.infer<typeof SyncStatusRes>;
export type SyncRunReqT = z.infer<typeof SyncRunReq>;
export type SyncRunResT = z.infer<typeof SyncRunRes>;
export type SyncReportEventT = z.infer<typeof SyncReportEvent>;
export type ReconcileActionEventT = z.infer<typeof ReconcileActionSchema>;

// ---------------------------------------------------------------------------
// Host state backup / restore — D bonus.
//
// `host:exportState` returns a JSON blob the user can save/transmit; restoring
// it on another host (or after a reinstall) reseeds installed.json and the
// settings block. We DO NOT export wizardAnswers fields containing secrets —
// the schema lets manifests author opaque text fields, so we round-trip
// everything as opaque values; the user is responsible for not exporting a
// host whose installed apps are storing PATs in their wizardAnswers.
// ---------------------------------------------------------------------------

const StateBackupSchema = z.object({
  /** schemaVersion of the backup — distinct from installed.json's `schema`. */
  backupSchema: z.literal(1),
  exportedAt: z.string().datetime(),
  /** Host that produced this export. Informational. */
  hostVersion: z.string(),
  /** Subset of installed.json. Only fields safe to round-trip across hosts. */
  apps: z.record(
    z.string(),
    z.object({
      version: z.string(),
      installScope: z.enum(['user', 'machine']),
      wizardAnswers: z.record(z.string(), z.unknown()),
      kind: z.enum(['app', 'agent']),
      updateChannel: z.enum(['stable', 'beta', 'internal']),
      autoUpdate: z.enum(['auto', 'ask', 'manual']),
    }),
  ),
  settings: InstalledStateSchema.shape.settings,
});

export const HostExportStateReq = z.object({});
export const HostExportStateRes = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), backup: StateBackupSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export const HostImportStateReq = z.object({
  backup: StateBackupSchema,
  /**
   * If true, also reconcile after import — install everything in the backup
   * that isn't already on disk. Default false: import is metadata-only by
   * default; the user can press "Sync now" if they want the actual installs.
   */
  reinstall: z.boolean().default(false),
});
export const HostImportStateRes = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    /** Number of app entries merged into installed.json. */
    appsMerged: z.number().int().nonnegative(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export type StateBackupT = z.infer<typeof StateBackupSchema>;
export type HostExportStateReqT = z.infer<typeof HostExportStateReq>;
export type HostExportStateResT = z.infer<typeof HostExportStateRes>;
export type HostImportStateReqT = z.infer<typeof HostImportStateReq>;
export type HostImportStateResT = z.infer<typeof HostImportStateRes>;

export { StateBackupSchema, SyncReportSchema, ReconcileActionSchema };
