/**
 * Tiny ANSI helpers for CLI output. We avoid pulling in chalk / picocolors
 * for a 5-color palette and a single bold helper. Honors NO_COLOR env var
 * (https://no-color.org/) — no flags, no fanfare.
 */

const NO_COLOR = process.env['NO_COLOR'] !== undefined || !process.stdout.isTTY;

const wrap = (open: number, close: number) => (s: string) =>
  NO_COLOR ? s : `\x1b[${open}m${s}\x1b[${close}m`;

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  red: wrap(31, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

/**
 * Format a fixed-width column. Pad on the right with spaces (or truncate
 * with an ellipsis) so adjacent columns align. Used by `vdx list`.
 */
export function pad(s: string, width: number): string {
  if (s.length === width) return s;
  if (s.length > width) return s.slice(0, Math.max(0, width - 1)) + '…';
  return s + ' '.repeat(width - s.length);
}

/**
 * One-line print that survives both TTY and pipe contexts. Newline at the
 * end so stdout flushes cleanly under `tee` and similar tools.
 */
export function println(s: string): void {
  process.stdout.write(s + '\n');
}

/**
 * Single-line "spinner-less" status line — write to stderr so it doesn't
 * pollute stdout output a user is piping. Cleared on the next call.
 */
let lastStatusWidth = 0;
export function status(s: string): void {
  if (NO_COLOR) {
    // No TTY redraw — just print with newline.
    process.stderr.write(s + '\n');
    return;
  }
  const out = `\r${s}${' '.repeat(Math.max(0, lastStatusWidth - s.length))}`;
  process.stderr.write(out);
  lastStatusWidth = s.length;
}

export function clearStatus(): void {
  if (NO_COLOR || lastStatusWidth === 0) return;
  process.stderr.write(`\r${' '.repeat(lastStatusWidth)}\r`);
  lastStatusWidth = 0;
}

/**
 * Promp the user with a Y/N question. Returns true on Y/y/'' (default yes
 * unless `defaultNo: true`). Reads a single line from stdin; if stdin is
 * not a TTY we treat it as `--yes` mode (the user is piping).
 */
export async function confirmYn(question: string, defaultNo = false): Promise<boolean> {
  if (!process.stdin.isTTY) return !defaultNo;
  process.stdout.write(`${question} ${defaultNo ? '[y/N]' : '[Y/n]'} `);
  return new Promise((resolve) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf-8');
      if (buf.includes('\n')) {
        process.stdin.off('data', onData);
        process.stdin.pause();
        const ans = buf.trim().toLowerCase();
        if (ans === '' || ans === 'y' || ans === 'yes') resolve(!defaultNo);
        else if (ans === 'n' || ans === 'no') resolve(defaultNo);
        else resolve(!defaultNo);
      }
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}
