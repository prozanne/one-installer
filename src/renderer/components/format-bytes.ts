/**
 * Pretty-print byte counts. Optimised for download speeds where the user
 * watches the number tick up — we want stable widths (1 decimal) and
 * predictable units (binary, base 1024) since installs ship in MiB.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatBytesPerSec(bps: number | undefined): string {
  if (bps === undefined || bps === 0) return '—';
  return `${formatBytes(bps)}/s`;
}

/**
 * Estimated time remaining, given downloaded / total / current speed.
 * Returns "—" when total or speed is unknown so the UI doesn't show fake numbers.
 */
export function formatEta(downloaded: number, total: number | undefined, bps: number | undefined): string {
  if (!total || !bps || bps === 0) return '—';
  const remaining = total - downloaded;
  if (remaining <= 0) return '0s';
  const sec = Math.round(remaining / bps);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return `${min}m${rem.toString().padStart(2, '0')}s`;
  const hr = Math.floor(min / 60);
  const m2 = min % 60;
  return `${hr}h${m2.toString().padStart(2, '0')}m`;
}
