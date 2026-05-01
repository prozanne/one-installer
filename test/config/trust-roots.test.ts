import { describe, it, expect } from 'vitest';
import { resolveTrustRoots } from '@main/config/trust-roots';
import type { VdxConfig } from '@shared/config/vdx-config';

// Two distinct 32-byte pubkeys, encoded canonically.
const PK1 = Buffer.alloc(32, 1).toString('base64');
const PK2 = Buffer.alloc(32, 2).toString('base64');

const baseConfig = (): VdxConfig => ({
  schemaVersion: 1,
  source: {
    type: 'github',
    github: {
      catalogRepo: 'samsung/vdx-catalog',
      selfUpdateRepo: 'samsung/vdx-installer',
      appsOrg: 'samsung',
      apiBase: 'https://api.github.com',
      ref: 'stable',
    },
  },
  channel: 'stable',
  developerMode: false,
  telemetry: false,
  trustRoots: [],
});

describe('resolveTrustRoots', () => {
  it('flattens bare-string entries unconditionally', () => {
    const config = { ...baseConfig(), trustRoots: [PK1, PK2] };
    const roots = resolveTrustRoots(config);
    expect(roots).toHaveLength(2);
    expect(Buffer.from(roots[0]!).toString('base64')).toBe(PK1);
    expect(Buffer.from(roots[1]!).toString('base64')).toBe(PK2);
  });

  it('accepts object-form entries inside their validity window', () => {
    const config = {
      ...baseConfig(),
      trustRoots: [
        { key: PK1, keyId: 'old', notBefore: '2025-01-01T00:00:00.000Z' },
        { key: PK2, keyId: 'new', notBefore: '2026-04-01T00:00:00.000Z' },
      ],
    };
    const roots = resolveTrustRoots(config, { asOf: '2026-05-01T00:00:00.000Z' });
    expect(roots).toHaveLength(2);
  });

  it('drops object-form entries whose notAfter has passed', () => {
    const config = {
      ...baseConfig(),
      trustRoots: [
        { key: PK1, keyId: 'old', notAfter: '2026-01-01T00:00:00.000Z' },
        { key: PK2, keyId: 'new' },
      ],
    };
    const roots = resolveTrustRoots(config, { asOf: '2026-05-01T00:00:00.000Z' });
    expect(roots).toHaveLength(1);
    expect(Buffer.from(roots[0]!).toString('base64')).toBe(PK2);
  });

  it('drops object-form entries whose notBefore has not yet arrived', () => {
    const config = {
      ...baseConfig(),
      trustRoots: [
        { key: PK1, keyId: 'old' },
        { key: PK2, keyId: 'future', notBefore: '2099-01-01T00:00:00.000Z' },
      ],
    };
    const roots = resolveTrustRoots(config, { asOf: '2026-05-01T00:00:00.000Z' });
    expect(roots).toHaveLength(1);
    expect(Buffer.from(roots[0]!).toString('base64')).toBe(PK1);
  });

  it('appends devPubKey when supplied', () => {
    const dev = new Uint8Array(32).fill(9);
    const config = { ...baseConfig(), trustRoots: [PK1] };
    const roots = resolveTrustRoots(config, { devPubKey: dev });
    expect(roots).toHaveLength(2);
    expect(roots[1]).toEqual(dev);
  });

  it('returns empty when trustRoots absent and no dev key', () => {
    const config = baseConfig();
    delete config.trustRoots;
    expect(resolveTrustRoots(config)).toEqual([]);
  });

  it('falls back to now() when asOf is absent or unparseable', () => {
    const config = {
      ...baseConfig(),
      trustRoots: [{ key: PK1, keyId: 'always' }],
    };
    expect(resolveTrustRoots(config).length).toBe(1);
    expect(resolveTrustRoots(config, { asOf: 'garbage' }).length).toBe(1);
  });
});
