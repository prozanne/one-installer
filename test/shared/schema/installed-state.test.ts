import { describe, it, expect } from 'vitest';
import { InstalledStateSchema } from '@shared/schema/installed-state';

describe('InstalledStateSchema', () => {
  it('accepts empty', () => {
    const s = {
      schema: 1 as const,
      host: { version: '1.0.0' },
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
    expect(() => InstalledStateSchema.parse(s)).not.toThrow();
  });

  it('rejects bad schema version', () => {
    expect(() => InstalledStateSchema.parse({ schema: 99 })).toThrow();
  });
});
