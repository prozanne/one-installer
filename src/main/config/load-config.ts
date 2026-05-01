/**
 * Config loader for vdx.config.json.
 *
 * Search order (highest precedence first):
 *   1. Next-to-EXE: same directory as vdx-installer.exe
 *   2. APPDATA: %APPDATA%/vdx-installer/vdx.config.json
 *   3. BUILTIN_DEFAULT_CONFIG (hardcoded fallback)
 *
 * Hard failures on schema-invalid files; never silently falls back.
 * Implements security invariants T9 and T10 from spec §4.6.
 *
 * @see docs/superpowers/specs/2026-05-01-package-source-abstraction.md §4, §6
 */
import * as path from 'node:path';
import * as os from 'node:os';
import * as nodeFsPromises from 'node:fs/promises';
import type { Result } from '@shared/types';
import { ok, err } from '@shared/types';
import { VdxConfigSchema } from '@shared/config/vdx-config';
import type { VdxConfig } from '@shared/config/vdx-config';
import { BUILTIN_DEFAULT_CONFIG } from '@shared/config/defaults';

// ---------------------------------------------------------------------------
// Singleton guard — loadVdxConfig MUST be called at most once per process.
// ---------------------------------------------------------------------------

let _loaded = false;

/**
 * Reset the singleton guard — FOR TESTS ONLY.
 * Do not call from production code.
 */
export function _resetLoadedForTest(): void {
  _loaded = false;
}

// ---------------------------------------------------------------------------
// FsLike — minimal interface for testability
// ---------------------------------------------------------------------------

export interface FsLike {
  readFile(path: string, encoding: 'utf-8'): Promise<string>;
  access(path: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// ConfigError
// ---------------------------------------------------------------------------

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// ---------------------------------------------------------------------------
// T9 — strip trust-shifting fields from per-user (APPDATA) configs
// ---------------------------------------------------------------------------

function stripTrustShiftingFields(
  cfg: VdxConfig,
  onIgnored: (field: string) => void,
): VdxConfig {
  const next: VdxConfig = structuredClone(cfg) as VdxConfig;

  if (next.trustRoots !== undefined) {
    onIgnored('trustRoots');
    delete (next as Partial<VdxConfig>).trustRoots;
  }

  if (next.developerMode === true) {
    onIgnored('developerMode');
    next.developerMode = false;
  }

  if (
    next.source.type === 'github' &&
    next.source.github !== undefined
  ) {
    const defaultApiBase = BUILTIN_DEFAULT_CONFIG.source.github.apiBase;
    if (next.source.github.apiBase !== defaultApiBase) {
      onIgnored('source.github.apiBase');
      next.source.github.apiBase = defaultApiBase;
    }
  }

  return next;
}

// ---------------------------------------------------------------------------
// Minimal logger interface — avoids circular dep on logging module
// ---------------------------------------------------------------------------

interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
}

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
};

// ---------------------------------------------------------------------------
// loadVdxConfig
// ---------------------------------------------------------------------------

export interface LoadVdxConfigOpts {
  /** Absolute path to the directory containing vdx-installer.exe. Pass empty string to skip. */
  exeDir: string;
  /** Absolute path to the application data directory (parent of vdx-installer/). */
  appDataDir: string;
  /** Injected fs for testability. Defaults to node:fs/promises. */
  fs?: FsLike;
  /** Logger for diagnostics. Defaults to no-op. */
  logger?: Logger;
}

/**
 * Locate, parse, and validate vdx.config.json.
 *
 * Returns `Result<VdxConfig, ConfigError>` so callers can branch on config
 * missing vs. schema-invalid vs. success without try/catch.
 *
 * In practice the caller will usually:
 *   const result = await loadVdxConfig(opts);
 *   if (!result.ok) throw result.error; // bubble ConfigError at startup
 */
export async function loadVdxConfig(
  opts: LoadVdxConfigOpts,
): Promise<Result<VdxConfig, ConfigError>> {
  if (_loaded) {
    throw new Error(
      'loadVdxConfig called more than once; config is immutable for the process lifetime.',
    );
  }
  _loaded = true;

  const fs: FsLike = opts.fs ?? {
    readFile: (p, enc) => nodeFsPromises.readFile(p, enc),
    access: (p) => nodeFsPromises.access(p),
  };
  const logger: Logger = opts.logger ?? noopLogger;

  // -------------------------------------------------------------------------
  // T10 — validate appDataDir is not CWD-relative
  // -------------------------------------------------------------------------

  const home = os.homedir();
  const appDataResolved = path.resolve(opts.appDataDir, 'vdx-installer', 'vdx.config.json');

  const appDataIsValid =
    appDataResolved.startsWith(path.resolve(home) + path.sep) ||
    appDataResolved.startsWith(path.resolve(home) + '/') ||
    appDataResolved === path.resolve(home) ||
    // On Windows APPDATA may be on a different drive than homedir
    (opts.appDataDir.length > 0 &&
      path.isAbsolute(opts.appDataDir) &&
      !opts.appDataDir.startsWith('.'));

  // Build candidate list
  const candidates: Array<{ filePath: string; scope: 'next-to-exe' | 'appdata' }> = [];

  if (opts.exeDir.length > 0) {
    candidates.push({
      filePath: path.join(opts.exeDir, 'vdx.config.json'),
      scope: 'next-to-exe',
    });
  }

  if (appDataIsValid) {
    candidates.push({ filePath: appDataResolved, scope: 'appdata' });
  } else {
    logger.warn('source.config.appdata-rejected', { resolved: appDataResolved });
  }

  // -------------------------------------------------------------------------
  // Walk candidates in precedence order
  // -------------------------------------------------------------------------

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;

    // Try to read the file
    let raw: string;
    try {
      raw = await fs.readFile(candidate.filePath, 'utf-8');
    } catch (e) {
      const errCode = (e as NodeJS.ErrnoException).code;
      if (errCode === 'ENOENT') continue;
      return err(
        new ConfigError(
          `Cannot read ${candidate.filePath}: ${(e as Error).message}`,
        ),
      );
    }

    // Detect shadowed lower-precedence configs (for diagnostic logging)
    const shadowed: string[] = [];
    for (const other of candidates.slice(i + 1)) {
      try {
        await fs.access(other.filePath);
        shadowed.push(other.filePath);
      } catch {
        // not present — expected
      }
    }
    if (shadowed.length > 0) {
      logger.warn('source.config.shadowed', {
        loaded: candidate.filePath,
        shadowed,
      });
    }

    // Parse JSON — hard fail on syntax error
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      return err(
        new ConfigError(
          `Failed to parse ${candidate.filePath}: ${(e as Error).message}`,
        ),
      );
    }

    // Validate schema — hard fail on invalid
    const parseResult = VdxConfigSchema.safeParse(obj);
    if (!parseResult.success) {
      const messages = parseResult.error.errors
        .map((e) => `  ${e.path.join('.')}: ${e.message}`)
        .join('\n');
      return err(
        new ConfigError(
          `Invalid vdx.config.json at ${candidate.filePath}:\n${messages}`,
        ),
      );
    }

    // T9 — strip trust-shifting fields from per-user config
    let cfg = parseResult.data;
    if (candidate.scope === 'appdata') {
      cfg = stripTrustShiftingFields(cfg, (field) =>
        logger.warn('source.config.field-ignored-appdata', {
          field,
          path: candidate.filePath,
        }),
      );
    }

    logger.info('source.config.loaded', {
      path: candidate.filePath,
      scope: candidate.scope,
      sourceType: cfg.source.type,
    });

    return ok(cfg);
  }

  // No config file found — return hardcoded defaults
  logger.info('source.config.using-defaults');

  const defaultResult = VdxConfigSchema.safeParse(BUILTIN_DEFAULT_CONFIG);
  if (!defaultResult.success) {
    // Should never happen — BUILTIN_DEFAULT_CONFIG is compile-time validated
    return err(
      new ConfigError(
        `Internal error: BUILTIN_DEFAULT_CONFIG failed schema validation: ` +
          defaultResult.error.message,
      ),
    );
  }

  return ok(defaultResult.data);
}

// ---------------------------------------------------------------------------
// redactConfigForLogs
// ---------------------------------------------------------------------------

/**
 * Returns a copy of the config safe for logging.
 * Strips: proxy URL credentials, httpMirror token + proxyUrl, full trustRoots.
 * Keeps: source type, github/local paths, channel, telemetry, developerMode flags.
 */
export function redactConfigForLogs(c: VdxConfig): Record<string, unknown> {
  const source: Record<string, unknown> = { type: c.source.type };

  if (c.source.type === 'github' && c.source.github) {
    source['github'] = {
      catalogRepo: c.source.github.catalogRepo,
      selfUpdateRepo: c.source.github.selfUpdateRepo,
      appsOrg: c.source.github.appsOrg,
      apiBase: c.source.github.apiBase,
      ref: c.source.github.ref,
    };
  }

  if (c.source.type === 'http-mirror' && c.source.httpMirror) {
    source['httpMirror'] = {
      baseUrl: c.source.httpMirror.baseUrl,
      token: c.source.httpMirror.token !== undefined ? '[REDACTED:TOKEN]' : undefined,
      proxyUrl:
        c.source.httpMirror.proxyUrl !== undefined
          ? redactUrlCredentials(c.source.httpMirror.proxyUrl)
          : undefined,
    };
  }

  if (c.source.type === 'local-fs' && c.source.localFs) {
    source['localFs'] = {
      rootPath: redactHomePath(c.source.localFs.rootPath),
    };
  }

  let proxyRedacted: Record<string, unknown> | undefined;
  if (c.proxy) {
    if (c.proxy.kind === 'explicit') {
      proxyRedacted = {
        kind: 'explicit',
        url: redactUrlCredentials(c.proxy.url),
      };
    } else {
      proxyRedacted = { kind: c.proxy.kind };
    }
  }

  return {
    schemaVersion: c.schemaVersion,
    source,
    // Show only an 8-char fingerprint of each trust root + its keyId (when
    // present). Full pubkey isn't a secret but is also useless in logs;
    // fingerprint + id is enough for "which root signed which catalog".
    trustRoots: c.trustRoots?.map((k) => {
      const key = typeof k === 'string' ? k : k.key;
      const id = typeof k === 'string' ? undefined : k.keyId;
      return id ? `${id}=${key.slice(0, 8)}...` : `${key.slice(0, 8)}...`;
    }),
    channel: c.channel,
    proxy: proxyRedacted,
    telemetry: c.telemetry,
    developerMode: c.developerMode,
  };
}

/** Strip user:pass@ from a URL string. */
function redactUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    // Not a valid URL — redact the whole thing
    return '[REDACTED:URL]';
  }
}

/** Replace the home directory prefix with ~/ in a path. */
function redactHomePath(p: string): string {
  const home = os.homedir();
  if (p.startsWith(home)) {
    return '~' + p.slice(home.length);
  }
  return p;
}
