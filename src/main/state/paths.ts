/**
 * Pure path helpers for the VDX installer state directory layout.
 *
 * All functions accept an explicit `baseDir` so they are fully mockable in tests.
 * In production the default is `%APPDATA%/vdx-installer` (resolved by the caller
 * via Platform.systemVars()); this module itself does NOT read any environment variable.
 */

const DEFAULT_BASE_DIR = '%APPDATA%/vdx-installer';

/** Path to the installed-app state file. */
export function installedJsonPath(baseDir: string = DEFAULT_BASE_DIR): string {
  return `${baseDir}/installed.json`;
}

/** Path to the backup of the installed-app state file. */
export function installedJsonBakPath(baseDir: string = DEFAULT_BASE_DIR): string {
  return `${baseDir}/installed.json.bak`;
}

/** Root of the download/cache directory. */
export function cacheDir(baseDir: string = DEFAULT_BASE_DIR): string {
  return `${baseDir}/cache`;
}

/** Per-app versioned cache directory, e.g. `cache/<appId>/<version>/`. */
export function cacheAppVersionDir(
  appId: string,
  version: string,
  baseDir: string = DEFAULT_BASE_DIR,
): string {
  return `${cacheDir(baseDir)}/${appId}/${version}`;
}

/** Directory for rolling log files. */
export function logsDir(baseDir: string = DEFAULT_BASE_DIR): string {
  return `${baseDir}/logs`;
}

/** Directory for per-app advisory lock files. */
export function locksDir(baseDir: string = DEFAULT_BASE_DIR): string {
  return `${baseDir}/locks`;
}

/** Directory for in-flight transaction journal files. */
export function journalDir(baseDir: string = DEFAULT_BASE_DIR): string {
  return `${baseDir}/journal`;
}
