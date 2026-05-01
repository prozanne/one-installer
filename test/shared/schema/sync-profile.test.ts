import { describe, it, expect } from 'vitest';
import { SyncProfileSchema } from '@shared/schema';

const validProfile = {
  schemaVersion: 1,
  name: 'Engineering Fleet',
  updatedAt: '2026-05-01T00:00:00.000Z',
  apps: [
    { id: 'com.samsung.vdx.x', kind: 'app', version: '1.2.3' },
    { id: 'com.samsung.vdx.y', kind: 'agent', version: 'latest', channel: 'beta' },
  ],
};

describe('SyncProfileSchema', () => {
  it('accepts a minimal valid profile', () => {
    const r = SyncProfileSchema.safeParse(validProfile);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.removeUnlisted).toBe(false); // default
      expect(r.data.apps[0]?.channel).toBe('stable'); // default
      expect(r.data.apps[0]?.wizardAnswers).toEqual({}); // default
    }
  });

  it('rejects unknown top-level keys (strict)', () => {
    const r = SyncProfileSchema.safeParse({ ...validProfile, garbage: 'no' });
    expect(r.success).toBe(false);
  });

  it('rejects malformed semver but accepts "latest"', () => {
    expect(
      SyncProfileSchema.safeParse({
        ...validProfile,
        apps: [{ id: 'a', kind: 'app', version: 'not-a-version' }],
      }).success,
    ).toBe(false);
    expect(
      SyncProfileSchema.safeParse({
        ...validProfile,
        apps: [{ id: 'a', kind: 'app', version: 'latest' }],
      }).success,
    ).toBe(true);
  });

  it('caps apps array at 256', () => {
    const big = Array.from({ length: 257 }, (_, i) => ({
      id: `id-${i}`,
      kind: 'app' as const,
      version: '1.0.0',
    }));
    expect(SyncProfileSchema.safeParse({ ...validProfile, apps: big }).success).toBe(false);
  });

  it('round-trips wizardAnswers as record<string, unknown>', () => {
    const r = SyncProfileSchema.safeParse({
      ...validProfile,
      apps: [
        {
          id: 'a',
          kind: 'app',
          version: '1.0.0',
          wizardAnswers: { installPath: '/opt/x', enableTelemetry: false, count: 3 },
        },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.apps[0]?.wizardAnswers).toEqual({
        installPath: '/opt/x',
        enableTelemetry: false,
        count: 3,
      });
    }
  });

  it('removeUnlisted is honored when explicitly set', () => {
    const r = SyncProfileSchema.safeParse({ ...validProfile, removeUnlisted: true });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.removeUnlisted).toBe(true);
  });
});
