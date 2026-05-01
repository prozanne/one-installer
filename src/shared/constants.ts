export const MANIFEST_SCHEMA_VERSION = 1 as const;
export const CATALOG_SCHEMA_VERSION = 1 as const;
export const INSTALLED_STATE_SCHEMA_VERSION = 1 as const;

export const APP_ID_REGEX = /^[a-z][a-z0-9-]{0,30}(\.[a-z][a-z0-9-]{0,30}){2,5}$/;
export const SEMVER_REGEX = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/;

export const TX_TIMEOUT_MS_DEFAULT = 30_000;
export const EXEC_TIMEOUT_MS_MAX = 300_000;
