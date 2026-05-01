/**
 * test/ipc/handlers-settings.test.ts
 *
 * Tests for the settings IPC handlers (get/set) in electron-main.ts.
 *
 * ALL TESTS SKIPPED — Two blocking issues prevent isolation:
 *
 * 1. COUPLING: electron-main.ts registers all ipcMain.handle() calls inside
 *    the async `main()` function which is immediately invoked at module load
 *    time via `void main()`. The handlers are not exported; they cannot be
 *    called without triggering app.whenReady() and the full Electron lifecycle.
 *    The mock below would unblock imports, but there is no surface to call
 *    individual handlers in isolation without a refactor to extract them into
 *    a separate module (e.g., src/main/ipc/handlers.ts).
 *
 * 2. MISSING FEATURE: As of R3, electron-main.ts does not register settings
 *    get/set IPC channels. IpcChannels has no 'settings:get' or 'settings:set'
 *    entries in ipc-types.ts, and no corresponding ipcMain.handle() calls exist
 *    in electron-main.ts. There is nothing to test.
 *
 * Resolution for R4:
 *   - Extract handler registration into src/main/ipc/register-handlers.ts
 *     (or similar) that accepts injected dependencies and returns a cleanup fn.
 *   - Add SettingsGetRes, SettingsSetReq schemas to ipc-types.ts.
 *   - Enable the tests below and fill in the bodies.
 *
 * See R3 test report for details.
 */

import { describe, it } from 'vitest';

// SKIPPED: impl missing + coupling — see R3 test report
describe.skip('settings:get handler', () => {
  it('returns full settings object from installed store', async () => {
    // SKIPPED: impl missing + coupling — see R3 test report
  });

  it('returned settings validates against SettingsGetRes schema', async () => {
    // SKIPPED: impl missing + coupling — see R3 test report
  });
});

// SKIPPED: impl missing + coupling — see R3 test report
describe.skip('settings:set handler', () => {
  it('patches a single key and persists', async () => {
    // SKIPPED: impl missing + coupling — see R3 test report
  });

  it('empty patch is a no-op (store unchanged)', async () => {
    // SKIPPED: impl missing + coupling — see R3 test report
  });

  it('rejects invalid value via zod (returns ok:false)', async () => {
    // SKIPPED: impl missing + coupling — see R3 test report
  });

  it('rejects unknown settings key', async () => {
    // SKIPPED: impl missing + coupling — see R3 test report
  });
});
