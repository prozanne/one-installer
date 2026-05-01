import { describe, it, expect } from 'vitest';
import {
  checkCatalogFreshness,
  getFreshnessAnchor,
  FRESHNESS_SKEW_MS,
} from '@main/catalog/freshness';
import { InstalledStateSchema } from '@shared/schema';

describe('checkCatalogFreshness', () => {
  it('accepts any timestamp on first launch (no anchor)', () => {
    expect(checkCatalogFreshness('2026-01-01T00:00:00.000Z', undefined).ok).toBe(true);
    expect(checkCatalogFreshness('2000-01-01T00:00:00.000Z', undefined).ok).toBe(true);
  });

  it('accepts a strictly newer catalog', () => {
    const r = checkCatalogFreshness(
      '2026-05-01T01:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
    );
    expect(r.ok).toBe(true);
  });

  it('accepts a same-instant catalog', () => {
    const ts = '2026-05-01T00:00:00.000Z';
    expect(checkCatalogFreshness(ts, ts).ok).toBe(true);
  });

  it('accepts within the skew window', () => {
    // Incoming is 30s older — under the 60s skew tolerance, allowed.
    const stored = '2026-05-01T00:00:30.000Z';
    const incoming = '2026-05-01T00:00:00.000Z';
    expect(checkCatalogFreshness(incoming, stored).ok).toBe(true);
  });

  it('refuses an obvious replay (older than anchor by > skew)', () => {
    const stored = '2026-05-01T01:00:00.000Z';
    const incoming = '2026-05-01T00:00:00.000Z'; // 1h older
    const r = checkCatalogFreshness(incoming, stored);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/replay/i);
  });

  it('refuses an unparseable incoming timestamp', () => {
    expect(checkCatalogFreshness('not-a-date', '2026-01-01T00:00:00.000Z').ok).toBe(false);
  });

  it('exports a sane skew constant', () => {
    expect(FRESHNESS_SKEW_MS).toBeGreaterThan(0);
    expect(FRESHNESS_SKEW_MS).toBeLessThan(10 * 60_000); // <10min — sanity
  });
});

describe('getFreshnessAnchor', () => {
  const baseState = {
    schema: 1 as const,
    host: { version: '0.1.0' },
    lastCatalogSync: null,
    settings: {
      language: 'en',
      updateChannel: 'stable' as const,
      autoUpdateHost: 'ask' as const,
      autoUpdateApps: 'ask' as const,
      cacheLimitGb: 5,
      proxy: null,
      telemetry: false,
      trayMode: false,
      developerMode: false,
    },
    apps: {},
  };

  it('returns undefined when catalogFreshness is absent', () => {
    const state = InstalledStateSchema.parse(baseState);
    expect(getFreshnessAnchor(state, 'app')).toBeUndefined();
    expect(getFreshnessAnchor(state, 'agent')).toBeUndefined();
  });

  it('returns the per-kind value when set', () => {
    const state = InstalledStateSchema.parse({
      ...baseState,
      catalogFreshness: { app: '2026-05-01T00:00:00.000Z' },
    });
    expect(getFreshnessAnchor(state, 'app')).toBe('2026-05-01T00:00:00.000Z');
    expect(getFreshnessAnchor(state, 'agent')).toBeUndefined();
  });
});
