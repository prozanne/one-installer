import type { Platform } from './types';
import { MockPlatform } from './mock';
import { WindowsPlatform } from './windows';
import { LinuxPlatform } from './linux';

/**
 * Pick the right Platform impl for the current process.
 *
 * - **Windows** → `WindowsPlatform` (reg.exe / PowerShell / tasklist; zero npm deps)
 * - **Linux**   → `LinuxPlatform` (JSON registry shim; .desktop shortcuts;
 *                  ~/.profile PATH; child_process exec)
 * - **macOS / dev / CI** → `MockPlatform` (in-memory; the engine still
 *   exercises the exact same code paths)
 *
 * Tests should always construct the impl directly — `selectPlatform` is
 * for the live electron-main path only.
 */
export function selectPlatform(opts: { elevationGranted?: boolean } = {}): Platform {
  if (process.platform === 'win32') {
    return new WindowsPlatform({ elevationGranted: opts.elevationGranted ?? false });
  }
  if (process.platform === 'linux') {
    return new LinuxPlatform({ elevationGranted: opts.elevationGranted ?? false });
  }
  return new MockPlatform();
}
