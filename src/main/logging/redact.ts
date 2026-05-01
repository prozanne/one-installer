/**
 * Best-effort secret scrubber for log lines, error messages, and any string
 * that may end up persisted to disk. The strategy is deny-by-pattern: every
 * known secret shape we'd be embarrassed to leak gets a regex.
 *
 * False positives (over-redacting an innocuous hex string) are far cheaper
 * than false negatives (leaking a real key into a support bundle), so the
 * patterns err on the side of aggressive matching.
 */

// All published GitHub token prefixes (PAT, OAuth, server-to-server, etc.)
// plus fine-grained PATs which use the `github_pat_` prefix.
const GH_TOKEN_RE = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g;
const GH_FG_PAT_RE = /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g;

// Generic Authorization headers and bearer tokens. Captures the prefix so the
// reader can tell what kind of credential was scrubbed.
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi;

// Long hex strings — Ed25519 keys (32-byte = 64 hex chars), SHA-256 digests,
// random session IDs. The library may include the offending bytes in error
// messages (e.g. `Error: invalid Point ...`), so we mask anything that looks
// hex-y and is at least 32 chars long. SHA-256 hashes from manifests will be
// caught too, but those are public-anyway content.
const LONG_HEX_RE = /\b(0x)?[a-fA-F0-9]{32,}\b/g;

// Slack tokens (xoxb-…, xoxp-…, etc.) and AWS access keys for completeness.
const SLACK_RE = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;
const AWS_RE = /\bAKIA[0-9A-Z]{16}\b/g;

// Match `/Users/<name>` but NOT the well-known shared accounts (Public,
// Shared, Guest) which aren't user-specific and stripping them adds no
// privacy benefit while losing context for support engineers reading
// stack traces or paths.
const HOME_RE_POSIX = /\/Users\/(?!(?:Public|Shared|Guest)\b)[^/\s]+/g;
const HOME_RE_WIN = /C:\\Users\\(?!(?:Public|Shared|Default)\b)[^\\\s]+/gi;

export function redact(input: string): string {
  return input
    .replace(GH_TOKEN_RE, '[REDACTED:GH-TOKEN]')
    .replace(GH_FG_PAT_RE, '[REDACTED:GH-PAT]')
    .replace(BEARER_RE, 'Bearer [REDACTED:BEARER]')
    .replace(SLACK_RE, '[REDACTED:SLACK]')
    .replace(AWS_RE, '[REDACTED:AWS]')
    .replace(LONG_HEX_RE, '[REDACTED:HEX]')
    .replace(HOME_RE_POSIX, '~')
    .replace(HOME_RE_WIN, '~');
}
