import { describe, it, expect } from 'vitest';
import { registryHandler } from '@main/engine/post-install/registry';
import { MockPlatform } from '@main/platform';

const baseCtx = (p: MockPlatform) => ({
  platform: p,
  templateContext: { installPath: '/Apps/X' },
  systemVars: p.systemVars(),
  installPath: '/Apps/X',
  appId: 'com.samsung.vdx.x',
  payloadDir: '/payload',
});

describe('registryHandler', () => {
  it('writes values, records inverse', async () => {
    const p = new MockPlatform();
    const entry = await registryHandler.apply(
      {
        type: 'registry',
        hive: 'HKCU',
        key: 'Software\\Samsung\\X',
        values: {
          InstallPath: { type: 'REG_SZ', data: '{{installPath}}' },
          Major: { type: 'REG_DWORD', data: 1 },
        },
      },
      baseCtx(p),
    );
    expect((await p.registryRead('HKCU', 'Software\\Samsung\\X', 'InstallPath'))?.data).toBe(
      '/Apps/X',
    );
    expect(entry.type).toBe('registry');
  });

  it('inverse deletes only values it created', async () => {
    const p = new MockPlatform();
    await p.registryWrite('HKCU', 'Software\\Samsung\\X', 'Existing', {
      type: 'REG_SZ',
      data: 'keep',
    });

    const entry = await registryHandler.apply(
      {
        type: 'registry',
        hive: 'HKCU',
        key: 'Software\\Samsung\\X',
        values: { New: { type: 'REG_SZ', data: 'gone' } },
      },
      baseCtx(p),
    );
    await registryHandler.inverse(entry, p);
    expect(await p.registryRead('HKCU', 'Software\\Samsung\\X', 'New')).toBeNull();
    expect((await p.registryRead('HKCU', 'Software\\Samsung\\X', 'Existing'))?.data).toBe('keep');
  });
});
