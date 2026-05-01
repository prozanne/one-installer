import { describe, it, expect } from 'vitest';
import { envPathHandler } from '@main/engine/post-install/env-path';
import { MockPlatform } from '@main/platform';

describe('envPathHandler', () => {
  it('adds and removes', async () => {
    const p = new MockPlatform();
    const entry = await envPathHandler.apply(
      { type: 'envPath', scope: 'user', add: '{{installPath}}/bin' },
      {
        platform: p,
        templateContext: { installPath: '/Apps/X' },
        systemVars: p.systemVars(),
        installPath: '/Apps/X',
        appId: 'x',
        payloadDir: '/payload',
      },
    );
    expect(p.userPath).toEqual(['/Apps/X/bin']);
    await envPathHandler.inverse(entry, p);
    expect(p.userPath).toEqual([]);
  });
});
