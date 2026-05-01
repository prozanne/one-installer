/**
 * Host info — what OS / hostname / arch / distro is the host running on.
 *
 * Surfaced via `host:info` IPC so the renderer can show "Connected to Linux
 * server: my-build-box" when running in headless mode (the user is most
 * likely browsing into a Linux server from a Windows desktop and needs to
 * remember which machine they're operating on).
 *
 * Linux distro detection reads /etc/os-release per the freedesktop.org
 * spec — present on every modern distribution we'd reasonably target
 * (Ubuntu, Debian, Fedora, RHEL, CentOS, Arch, openSUSE, Alpine).
 */
import { existsSync, readFileSync } from 'node:fs';
import { hostname, release } from 'node:os';

export interface HostInfo {
  platform: string;
  osLabel: string;
  hostname: string;
  distro: string | null;
  headless: boolean;
  hostVersion: string;
  arch: string;
}

/**
 * Parse a `KEY=VALUE` os-release file into a flat record. Values may be
 * single-quoted, double-quoted, or bare. Lines that don't match are
 * silently skipped — we only care about ID / VERSION_ID / PRETTY_NAME.
 */
function parseOsRelease(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

export function readLinuxDistro(): { id: string | null; pretty: string | null } {
  const candidates = ['/etc/os-release', '/usr/lib/os-release'];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const r = parseOsRelease(readFileSync(path, 'utf-8'));
      const id = r['ID'] ?? null;
      const ver = r['VERSION_ID'] ?? null;
      const compact = id && ver ? `${id}-${ver}` : id;
      const pretty = r['PRETTY_NAME'] ?? (compact ?? null);
      return { id: compact, pretty };
    } catch {
      /* try next candidate */
    }
  }
  return { id: null, pretty: null };
}

/**
 * Render a human-friendly "OS name + version" string from raw uname/Win32
 * data. Falls back to `process.platform release()` if no nicer source
 * is available.
 */
export function osLabel(platform: string): string {
  if (platform === 'darwin') return `macOS ${release()}`;
  if (platform === 'win32') {
    // os.release() on Windows returns NT version like "10.0.22631"; map
    // the major.minor pair to a human label. Best-effort — Win11 is
    // technically NT 10.0 with build >= 22000.
    const r = release();
    const parts = r.split('.');
    const build = Number(parts[2] ?? 0);
    if (build >= 22000) return `Windows 11 (build ${build})`;
    if (parts[0] === '10') return `Windows 10 (build ${build})`;
    return `Windows ${r}`;
  }
  if (platform === 'linux') {
    const { pretty } = readLinuxDistro();
    return pretty ?? `Linux ${release()}`;
  }
  return `${platform} ${release()}`;
}

export function buildHostInfo(opts: { headless: boolean; hostVersion: string }): HostInfo {
  const platform = process.platform;
  return {
    platform,
    osLabel: osLabel(platform),
    hostname: hostname(),
    distro: platform === 'linux' ? readLinuxDistro().id : null,
    headless: opts.headless,
    hostVersion: opts.hostVersion,
    arch: process.arch,
  };
}
