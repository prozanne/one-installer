/**
 * Settings IPC handler tests.
 *
 * Targets the pure functions in `src/main/ipc/handlers/settings.ts`. The
 * coupling-to-Electron-lifecycle issue that previously blocked these is gone:
 * each handler is now a `(deps, raw) => Promise<Res>` over an injected
 * `installedStore`, so we can construct an in-memory store and exercise the
 * handler directly.
 */
import { describe, it, expect } from 'vitest';
import { handleSettingsGet, handleSettingsSet } from '@main/ipc/handlers/settings';
import { createInstalledStore } from '@main/state/installed-store';
import { MockPlatform } from '@main/platform';

const HOST_VER = '0.1.0';

async function freshStore() {
  const p = new MockPlatform();
  await p.ensureDir('/state');
  const store = createInstalledStore('/state/installed.json', p.fs, HOST_VER);
  return { p, store };
}

describe('settings:get handler', () => {
  it('returns the full settings object on default state', async () => {
    const { store } = await freshStore();
    const res = await handleSettingsGet({ installedStore: store }, {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.settings.language).toBe('en');
      expect(res.settings.updateChannel).toBe('stable');
      expect(res.settings.developerMode).toBe(false);
    }
  });

  it('returned settings object validates against the SettingsSchema (round-trip)', async () => {
    const { store } = await freshStore();
    const res = await handleSettingsGet({ installedStore: store }, undefined);
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Round-trip: set every key back through settings:set and confirm equality.
      const echo = await handleSettingsSet(
        { installedStore: store },
        { patch: res.settings },
      );
      expect(echo.ok).toBe(true);
      if (echo.ok) expect(echo.settings).toEqual(res.settings);
    }
  });

  it('returns ok:false when raw is malformed (non-object)', async () => {
    const { store } = await freshStore();
    const res = await handleSettingsGet({ installedStore: store }, 'not-an-object');
    expect(res.ok).toBe(false);
  });
});

describe('settings:set handler', () => {
  it('patches a single key and persists across reads', async () => {
    const { store } = await freshStore();
    const res = await handleSettingsSet(
      { installedStore: store },
      { patch: { language: 'ko' } },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.settings.language).toBe('ko');
    // Confirm persistence: a fresh read sees the patched value.
    const next = await handleSettingsGet({ installedStore: store }, {});
    if (next.ok) expect(next.settings.language).toBe('ko');
  });

  it('empty patch is a no-op (settings unchanged)', async () => {
    const { store } = await freshStore();
    const before = await handleSettingsGet({ installedStore: store }, {});
    const res = await handleSettingsSet({ installedStore: store }, { patch: {} });
    expect(res.ok).toBe(true);
    if (res.ok && before.ok) expect(res.settings).toEqual(before.settings);
  });

  it('rejects an invalid value via zod (returns ok:false)', async () => {
    const { store } = await freshStore();
    const res = await handleSettingsSet(
      { installedStore: store },
      // updateChannel is z.enum(['stable','beta','internal']) — 'wild' is invalid
      { patch: { updateChannel: 'wild' } },
    );
    expect(res.ok).toBe(false);
  });

  it('rejects an unknown settings key (zod strips or rejects)', async () => {
    const { store } = await freshStore();
    const res = await handleSettingsSet(
      { installedStore: store },
      { patch: { fakeSetting: 42 } as never },
    );
    // Zod's .partial() on a strict schema either rejects or silently strips —
    // either is acceptable as long as no settings keys we *don't* know about
    // end up in the persisted state.
    if (res.ok) {
      const next = await handleSettingsGet({ installedStore: store }, {});
      if (next.ok) {
        expect((next.settings as Record<string, unknown>)['fakeSetting']).toBeUndefined();
      }
    }
  });

  it('returns ok:false when raw is missing the patch field', async () => {
    const { store } = await freshStore();
    const res = await handleSettingsSet({ installedStore: store }, {});
    expect(res.ok).toBe(false);
  });
});
