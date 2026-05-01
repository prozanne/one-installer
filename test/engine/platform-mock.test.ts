import { describe, it, expect } from 'vitest';
import { MockPlatform } from '@main/platform';

describe('MockPlatform', () => {
  it('writes and reads files', async () => {
    const p = new MockPlatform();
    await p.ensureDir('/tmp');
    await p.fs.promises.writeFile('/tmp/x.txt', 'hi');
    expect(await p.pathExists('/tmp/x.txt')).toBe(true);
  });

  it('hashes files', async () => {
    const p = new MockPlatform();
    await p.ensureDir('/tmp');
    await p.fs.promises.writeFile('/tmp/x.txt', 'abc');
    expect(await p.fileSha256('/tmp/x.txt')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('writes registry values', async () => {
    const p = new MockPlatform();
    await p.registryWrite('HKCU', 'Software\\X', 'V', { type: 'REG_SZ', data: 'hello' });
    expect(await p.registryRead('HKCU', 'Software\\X', 'V')).toEqual({
      type: 'REG_SZ',
      data: 'hello',
    });
  });

  it('manages env path', async () => {
    const p = new MockPlatform();
    await p.pathEnvAdd('user', '/Apps/X/bin');
    expect(p.userPath).toEqual(['/Apps/X/bin']);
    await p.pathEnvAdd('user', '/Apps/X/bin');
    expect(p.userPath).toEqual(['/Apps/X/bin']);
    await p.pathEnvRemove('user', '/Apps/X/bin');
    expect(p.userPath).toEqual([]);
  });
});
