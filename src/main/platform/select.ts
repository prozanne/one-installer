import type { Platform } from './types';
import { MockPlatform } from './mock';
import { WindowsPlatform } from './windows';

/**
 * Pick the right Platform impl for the current process.
 *
 * - On real Windows we use `WindowsPlatform` (zero npm deps; shells out to
 *   reg.exe / powershell / tasklist).
 * - Anywhere else (macOS dev, Linux CI) we use `MockPlatform` so the engine
 *   exercises the same code paths against an in-memory FS.
 *
 * Tests should always construct `MockPlatform` directly — `selectPlatform`
 * is for the live electron-main path only.
 */
export function selectPlatform(opts: { elevationGranted?: boolean } = {}): Platform {
  if (process.platform === 'win32') {
    return new WindowsPlatform({ elevationGranted: opts.elevationGranted ?? false });
  }
  return new MockPlatform();
}
