/**
 * picker-allowlist — single-use file-path gate for the sideload picker.
 *
 * The renderer can name an arbitrary path on a `sideload:open` IPC; without
 * this gate, main would happily `readFileSync` whatever it sees, turning IPC
 * into an unrestricted `fs.readFile` proxy. The allowlist is populated by
 * `sideload:pick` (which uses an OS file dialog under the user's eye) and
 * consumed once by `sideload:open`. Replays and arbitrary paths fail.
 *
 * Pure module — no Electron / fs dependency — so behavior is unit-testable.
 */

export interface PickerAllowlist {
  /** Stage a path returned by the file picker. Single-use semantics. */
  remember(p: string): void;
  /**
   * Atomically check + remove. Returns true if the path was allowlisted (and
   * is now consumed); false if the path was never registered or already used.
   */
  claim(p: string): boolean;
  /** Test/diagnostic accessor — number of paths currently staged. */
  size(): number;
  /** Test-only: drop everything (e.g. between test cases). */
  clear(): void;
}

export interface PickerAllowlistOpts {
  /**
   * Cap on staged paths. When the cap is reached, the oldest entry is evicted
   * before adding the new one — this bounds the worst-case "spam pickVdxpkg"
   * memory growth.
   */
  maxPaths?: number;
}

const DEFAULT_MAX_PATHS = 16;

export function createPickerAllowlist(opts: PickerAllowlistOpts = {}): PickerAllowlist {
  const max = opts.maxPaths ?? DEFAULT_MAX_PATHS;
  // Set preserves insertion order per ECMA spec — first key is the oldest.
  const paths = new Set<string>();

  return {
    remember(p) {
      // Re-stage: drop the existing entry so re-adding moves it to the end
      // (i.e. "most recently picked"). Without this, picking the same file
      // twice would keep the *first* timestamp and the second pick would be
      // evicted earlier than expected.
      if (paths.has(p)) paths.delete(p);
      if (paths.size >= max) {
        const oldest = paths.values().next().value;
        if (oldest !== undefined) paths.delete(oldest);
      }
      paths.add(p);
    },
    claim(p) {
      return paths.delete(p);
    },
    size() {
      return paths.size;
    },
    clear() {
      paths.clear();
    },
  };
}
