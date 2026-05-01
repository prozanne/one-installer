import { describe, it, expect } from 'vitest';
import { handleAppsList } from '@main/ipc/handlers/apps';
import { createInstalledStore } from '@main/state/installed-store';
import { MockPlatform } from '@main/platform';

describe('apps:list handler', () => {
  it('returns the apps record from installedStore', async () => {
    const p = new MockPlatform();
    await p.ensureDir('/state');
    const store = createInstalledStore('/state/installed.json', p.fs, '0.1.0');
    const res = await handleAppsList({ installedStore: store });
    expect(res).toEqual({});
  });
});
