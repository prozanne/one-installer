/**
 * mem-platform.ts
 *
 * Convenience factory for the in-memory MockPlatform.
 * Wraps src/main/platform/mock.ts and pre-seeds the filesystem with any
 * files provided in `opts.initialFs`.
 *
 * Re-exports the MockPlatform class and its option type so callers can
 * import everything they need from this one helper module.
 */

import { MockPlatform } from '@main/platform/mock';
import type { MockPlatformOptions } from '@main/platform/mock';

export type { MockPlatformOptions };
export { MockPlatform };

export interface CreateMemPlatformOpts extends MockPlatformOptions {
  /**
   * Files to pre-seed into the in-memory filesystem.
   * Keys are absolute paths; values are file contents (string → UTF-8, Uint8Array → raw bytes).
   */
  initialFs?: Record<string, string | Uint8Array>;
}

/**
 * Create a fresh MockPlatform instance with optional pre-seeded filesystem.
 *
 * @example
 * const platform = await createMemPlatform({
 *   initialFs: {
 *     '/app/data/config.json': JSON.stringify({ ok: true }),
 *   },
 * });
 * // platform.fs is fully seeded and ready for tests
 */
export async function createMemPlatform(opts: CreateMemPlatformOpts = {}): Promise<MockPlatform> {
  const { initialFs, ...platformOpts } = opts;
  const platform = new MockPlatform(platformOpts);

  if (initialFs) {
    for (const [filePath, content] of Object.entries(initialFs)) {
      // Ensure parent directory exists
      const dir = filePath.replace(/\/[^/]*$/, '') || '/';
      await platform.fs.promises.mkdir(dir, { recursive: true });
      const buf =
        typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content);
      await platform.fs.promises.writeFile(filePath, buf);
    }
  }

  return platform;
}
