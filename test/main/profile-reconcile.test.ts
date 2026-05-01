import { describe, it, expect, vi } from 'vitest';
import { reconcileProfile, type ReconcileDeps } from '@main/sync/profile-reconcile';
import type { ProfileDrift } from '@main/sync/profile-diff';

const profileApp = (id: string) => ({
  id,
  kind: 'app' as const,
  version: '1.0.0',
  channel: 'stable' as const,
  wizardAnswers: {},
});

const installedDeps = (
  overrides: Partial<ReconcileDeps> = {},
): ReconcileDeps => ({
  installApp: vi.fn().mockResolvedValue({ ok: true, version: '1.0.0' }),
  uninstallApp: vi.fn().mockResolvedValue({ ok: true }),
  ...overrides,
});

describe('reconcileProfile', () => {
  it('installs missing apps', async () => {
    const deps = installedDeps();
    const drift: ProfileDrift[] = [
      { kind: 'missing', profileApp: profileApp('a'), catalogItem: null, unresolvable: false },
    ];
    const r = await reconcileProfile(deps, { profileName: 'P', drift, dryRun: false });
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]?.kind).toBe('installed');
    expect(deps.installApp).toHaveBeenCalledTimes(1);
  });

  it('records unresolvable missing as failed', async () => {
    const deps = installedDeps();
    const drift: ProfileDrift[] = [
      { kind: 'missing', profileApp: profileApp('a'), catalogItem: null, unresolvable: true },
    ];
    const r = await reconcileProfile(deps, { profileName: 'P', drift, dryRun: false });
    expect(r.actions[0]?.kind).toBe('failed');
    expect(deps.installApp).not.toHaveBeenCalled();
  });

  it('updates outdated apps', async () => {
    const deps = installedDeps({
      installApp: vi.fn().mockResolvedValue({ ok: true, version: '2.0.0' }),
    });
    const drift: ProfileDrift[] = [
      {
        kind: 'outdated',
        profileApp: profileApp('a'),
        fromVersion: '1.0.0',
        toVersion: '2.0.0',
        catalogItem: null,
      },
    ];
    const r = await reconcileProfile(deps, { profileName: 'P', drift, dryRun: false });
    expect(r.actions[0]?.kind).toBe('updated');
    if (r.actions[0]?.kind === 'updated') {
      expect(r.actions[0].fromVersion).toBe('1.0.0');
      expect(r.actions[0].toVersion).toBe('2.0.0');
    }
  });

  it('uninstalls extras', async () => {
    const deps = installedDeps();
    const drift: ProfileDrift[] = [
      {
        kind: 'extra',
        appId: 'b',
        installed: {
          version: '1.0.0',
          installScope: 'user',
          installPath: '/i/b',
          wizardAnswers: {},
          journal: [],
          manifestSnapshot: {} as never,
          installedAt: '2026-04-01T00:00:00.000Z',
          updateChannel: 'stable',
          autoUpdate: 'ask',
          source: 'catalog',
          kind: 'app',
        },
      },
    ];
    const r = await reconcileProfile(deps, { profileName: 'P', drift, dryRun: false });
    expect(r.actions[0]?.kind).toBe('uninstalled');
    expect(deps.uninstallApp).toHaveBeenCalledTimes(1);
  });

  it('captures install failures without throwing', async () => {
    const deps = installedDeps({
      installApp: vi.fn().mockResolvedValue({ ok: false, error: 'boom' }),
    });
    const drift: ProfileDrift[] = [
      { kind: 'missing', profileApp: profileApp('a'), catalogItem: null, unresolvable: false },
    ];
    const r = await reconcileProfile(deps, { profileName: 'P', drift, dryRun: false });
    expect(r.actions[0]?.kind).toBe('failed');
  });

  it('dryRun skips delegate calls and synthesizes "skipped" actions', async () => {
    const deps = installedDeps();
    const drift: ProfileDrift[] = [
      { kind: 'missing', profileApp: profileApp('a'), catalogItem: null, unresolvable: false },
      {
        kind: 'outdated',
        profileApp: profileApp('b'),
        fromVersion: '1.0.0',
        toVersion: '2.0.0',
        catalogItem: null,
      },
    ];
    const r = await reconcileProfile(deps, { profileName: 'P', drift, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.actions).toHaveLength(2);
    expect(r.actions.every((a) => a.kind === 'skipped')).toBe(true);
    expect(deps.installApp).not.toHaveBeenCalled();
    expect(deps.uninstallApp).not.toHaveBeenCalled();
  });

  it('passes profile wizardAnswers + channel to installApp', async () => {
    const installApp = vi.fn().mockResolvedValue({ ok: true, version: '1.0.0' });
    const drift: ProfileDrift[] = [
      {
        kind: 'missing',
        profileApp: {
          ...profileApp('a'),
          wizardAnswers: { installPath: '/opt/a' },
          channel: 'beta',
        },
        catalogItem: null,
        unresolvable: false,
      },
    ];
    await reconcileProfile(installedDeps({ installApp }), {
      profileName: 'P',
      drift,
      dryRun: false,
    });
    expect(installApp).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'a',
        wizardAnswers: { installPath: '/opt/a' },
        channel: 'beta',
      }),
    );
  });
});
