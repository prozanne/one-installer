import { describe, it, expect, vi } from 'vitest';
import { handleSyncStatus, handleSyncRun } from '@main/ipc/handlers/sync';
import type { SyncProfileT, InstalledStateT } from '@shared/schema';

const baseInstalled = (overrides: Partial<InstalledStateT> = {}): InstalledStateT =>
  ({
    schema: 1,
    host: { version: '0.1.0' },
    lastCatalogSync: null,
    settings: {
      language: 'en',
      updateChannel: 'stable',
      autoUpdateHost: 'ask',
      autoUpdateApps: 'ask',
      cacheLimitGb: 5,
      proxy: null,
      telemetry: false,
      trayMode: false,
      developerMode: false,
    },
    apps: {},
    ...overrides,
  }) as InstalledStateT;

const cachedProfile: SyncProfileT = {
  schemaVersion: 1,
  name: 'My Fleet',
  updatedAt: '2026-05-01T00:00:00.000Z',
  apps: [],
  removeUnlisted: false,
};

describe('handleSyncStatus', () => {
  it('returns enabled:false when no syncProfile is configured', async () => {
    const r = await handleSyncStatus(
      {
        profileUrl: () => null,
        cachedProfile: () => null,
        readInstalled: async () => baseInstalled(),
        inFlight: () => false,
        runReconcile: vi.fn(),
      },
      {},
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.enabled).toBe(false);
      expect(r.profileName).toBeNull();
    }
  });

  it('returns profileName from the in-memory cache', async () => {
    const r = await handleSyncStatus(
      {
        profileUrl: () => 'https://example.invalid/profile.json',
        cachedProfile: () => cachedProfile,
        readInstalled: async () => baseInstalled(),
        inFlight: () => false,
        runReconcile: vi.fn(),
      },
      {},
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.enabled).toBe(true);
      expect(r.profileName).toBe('My Fleet');
    }
  });

  it('falls back to lastReport.profileName when cache is empty', async () => {
    const r = await handleSyncStatus(
      {
        profileUrl: () => 'https://example.invalid/profile.json',
        cachedProfile: () => null,
        readInstalled: async () =>
          baseInstalled({
            lastSyncReport: {
              profileName: 'Stored',
              startedAt: '2026-04-30T00:00:00.000Z',
              finishedAt: '2026-04-30T00:00:01.000Z',
              dryRun: false,
              actions: [],
            },
          }),
        inFlight: () => false,
        runReconcile: vi.fn(),
      },
      {},
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profileName).toBe('Stored');
  });

  it('surfaces inFlight flag', async () => {
    const r = await handleSyncStatus(
      {
        profileUrl: () => 'https://example.invalid/profile.json',
        cachedProfile: () => cachedProfile,
        readInstalled: async () => baseInstalled(),
        inFlight: () => true,
        runReconcile: vi.fn(),
      },
      {},
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.inFlight).toBe(true);
  });
});

describe('handleSyncRun', () => {
  it('refuses when sync is unconfigured', async () => {
    const r = await handleSyncRun(
      {
        profileUrl: () => null,
        cachedProfile: () => null,
        readInstalled: async () => baseInstalled(),
        inFlight: () => false,
        runReconcile: vi.fn(),
      },
      {},
    );
    expect(r.ok).toBe(false);
  });

  it('refuses when a reconcile is already in flight', async () => {
    const r = await handleSyncRun(
      {
        profileUrl: () => 'https://example.invalid/profile.json',
        cachedProfile: () => null,
        readInstalled: async () => baseInstalled(),
        inFlight: () => true,
        runReconcile: vi.fn(),
      },
      {},
    );
    expect(r.ok).toBe(false);
  });

  it('passes dryRun through and returns the report on success', async () => {
    const runReconcile = vi.fn().mockResolvedValue({
      ok: true,
      report: {
        profileName: 'P',
        startedAt: '2026-05-01T00:00:00.000Z',
        finishedAt: '2026-05-01T00:00:01.000Z',
        dryRun: true,
        actions: [],
      },
    });
    const r = await handleSyncRun(
      {
        profileUrl: () => 'https://example.invalid/profile.json',
        cachedProfile: () => null,
        readInstalled: async () => baseInstalled(),
        inFlight: () => false,
        runReconcile,
      },
      { dryRun: true },
    );
    expect(r.ok).toBe(true);
    expect(runReconcile).toHaveBeenCalledWith({ dryRun: true });
  });

  it('propagates engine errors as ok:false', async () => {
    const r = await handleSyncRun(
      {
        profileUrl: () => 'https://example.invalid/profile.json',
        cachedProfile: () => null,
        readInstalled: async () => baseInstalled(),
        inFlight: () => false,
        runReconcile: vi.fn().mockResolvedValue({ ok: false, error: 'sig failed' }),
      },
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/sig failed/);
  });
});
