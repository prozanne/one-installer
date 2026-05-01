const PAT_RE = /\bghp_[A-Za-z0-9]{20,}\b/g;
const HOME_RE_POSIX = /\/Users\/[^/\s]+/g;
const HOME_RE_WIN = /C:\\Users\\[^\\\s]+/gi;

export function redact(input: string): string {
  return input
    .replace(PAT_RE, '[REDACTED:GH-PAT]')
    .replace(HOME_RE_POSIX, '~')
    .replace(HOME_RE_WIN, '~');
}
