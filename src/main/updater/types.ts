/**
 * Types for the VDX Installer self-update subsystem.
 *
 * Phase 1.1: download + hash verification only.
 * Phase 1.2 (Windows-specific): Authenticode verification + replace-on-restart.
 *
 * @see docs/superpowers/specs/2026-05-01-vdx-installer-design.md §5.1
 */

export interface UpdateInfo {
  /** Semver string of the available update (e.g. "1.2.0"). */
  latestVersion: string;
  /** Semver string of the currently running host (e.g. "0.1.0-dev"). */
  currentVersion: string;
  /** Direct download URL for the updated installer binary/package. */
  downloadUrl: string;
  /** Optional human-readable release notes (markdown). */
  releaseNotes?: string | undefined;
}

/** Discriminated union result from checkForHostUpdate / downloadHostUpdate. */
export type UpdateResult =
  | { status: 'up-to-date' }
  | { status: 'available'; info: UpdateInfo }
  | { status: 'downloaded'; destPath: string }
  | { status: 'error'; error: string };
