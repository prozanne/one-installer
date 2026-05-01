/**
 * Zod schema for vdx.config.json.
 *
 * IMPORTANT: this module is in `src/shared/` and must remain importable from
 * the Electron renderer (which runs with contextIsolation + sandbox and has
 * no Node built-ins). Do NOT import from 'node:*' here. Path-shape checks
 * are implemented as regex; main-process semantic validation (e.g. fs.access
 * on rootPath) lives next to the source classes in `src/main/source/`.
 *
 * @see docs/superpowers/specs/2026-05-01-package-source-abstraction.md §4
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Trust-root validator
// ---------------------------------------------------------------------------

/**
 * Strict canonical base64 for a 32-byte Ed25519 public key.
 * 32 bytes → 44 chars (43 base64 chars + 1 padding `=`). The trailing pad slot
 * only allows certain characters in canonical form, and Buffer.from is lenient,
 * so we verify both the regex shape AND that the value round-trips back to the
 * same string after decode/encode (defeats non-canonical encodings).
 */
const STRICT_BASE64_44 = /^[A-Za-z0-9+/]{43}=$/;

const Base64PubKey = z
  .string()
  .refine(
    (s) => {
      if (!STRICT_BASE64_44.test(s)) return false;
      const buf = Buffer.from(s, 'base64');
      if (buf.length !== 32) return false;
      return buf.toString('base64') === s; // canonical round-trip check
    },
    { message: 'trustRoots entry must be a canonical base64-encoded 32-byte Ed25519 public key' },
  );

// ---------------------------------------------------------------------------
// Path-shape validator (no node:path — renderer-safe)
// ---------------------------------------------------------------------------

/**
 * Path-shape check that does not require node:path. Accepts:
 *   - POSIX absolute: starts with "/"
 *   - Windows drive-absolute: "C:\..." or "C:/..."
 *   - UNC: "\\server\share\..." or "//server/share/..."
 */
const ABSOLUTE_PATH_RE =
  /^(?:\/(?!\/)|[A-Za-z]:[\\/]|[/\\]{2}[^/\\]+[/\\][^/\\]+)/;

// ---------------------------------------------------------------------------
// Source-specific configs
// ---------------------------------------------------------------------------

const GitHubSourceConfig = z.object({
  catalogRepo: z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i),
  selfUpdateRepo: z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i),
  appsOrg: z.string().min(1),
  apiBase: z.string().url(),
  ref: z.string().min(1),
});

const HttpMirrorSourceConfig = z.object({
  baseUrl: z.string().url(),
  token: z.string().optional(),
  proxyUrl: z.string().url().optional(),
});

const LocalFsSourceConfig = z.object({
  /**
   * rootPath must be absolute. Shape-only regex check at the schema layer;
   * existence and accessibility of the directory are verified at LocalFsSource
   * construction time in the main process.
   */
  rootPath: z
    .string()
    .min(1)
    .max(32_767) // Windows MAX_PATH-with-prefix ceiling; arbitrary but bounded
    .refine(
      (p) => ABSOLUTE_PATH_RE.test(p),
      { message: 'rootPath must be absolute (e.g. "C:/path", "/path", or "//server/share/...")' },
    ),
});

// ---------------------------------------------------------------------------
// Discriminated source union
// ---------------------------------------------------------------------------

const SourceConfig = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('github'),
    github: GitHubSourceConfig,
    httpMirror: z.undefined().optional(),
    localFs: z.undefined().optional(),
  }),
  z.object({
    type: z.literal('http-mirror'),
    httpMirror: HttpMirrorSourceConfig,
    github: z.undefined().optional(),
    localFs: z.undefined().optional(),
  }),
  z.object({
    type: z.literal('local-fs'),
    localFs: LocalFsSourceConfig,
    github: z.undefined().optional(),
    httpMirror: z.undefined().optional(),
  }),
]);

// ---------------------------------------------------------------------------
// Proxy config
// ---------------------------------------------------------------------------

const ProxyConfig = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('system') }),
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('explicit'), url: z.string().url() }),
]);

// ---------------------------------------------------------------------------
// Top-level schema
// ---------------------------------------------------------------------------

/**
 * Agent catalog — distinct from the primary `source` block because agents are
 * usually published as a static catalog.json on GitHub Pages (no Releases API
 * involvement, no cross-repo crawl). Keeping it as plain URLs avoids forcing
 * GitHub Pages operators to host a full PackageSource layout. URLs only —
 * trust still flows through the same trustRoots.
 */
const AgentCatalogConfig = z.object({
  url: z.string().url(),
  sigUrl: z.string().url(),
});

export const VdxConfigSchema = z.object({
  schemaVersion: z.literal(1),
  source: SourceConfig,
  agentCatalog: AgentCatalogConfig.optional(),
  trustRoots: z.array(Base64PubKey).max(16).optional(),
  channel: z.enum(['stable', 'beta', 'internal']).default('stable'),
  proxy: ProxyConfig.optional(),
  telemetry: z.boolean().default(true),
  developerMode: z.boolean().default(false),
});

export type VdxConfig = z.infer<typeof VdxConfigSchema>;

// ---------------------------------------------------------------------------
// Exported sub-types for helpers that branch on source.type
// ---------------------------------------------------------------------------

export type GitHubSourceConfigT = z.infer<typeof GitHubSourceConfig>;
export type HttpMirrorSourceConfigT = z.infer<typeof HttpMirrorSourceConfig>;
export type LocalFsSourceConfigT = z.infer<typeof LocalFsSourceConfig>;
export type ProxyConfigT = z.infer<typeof ProxyConfig>;

// Re-export individual schema objects for consumers that need them
export { GitHubSourceConfig, HttpMirrorSourceConfig, LocalFsSourceConfig, ProxyConfig };
