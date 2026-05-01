import { describe, it, expect } from 'vitest';
import { atomicWriteJson, readJsonOrDefault } from '@main/state/atomic-write';
import { MockPlatform } from '@main/platform';

describe('atomicWriteJson', () => {
  it('writes via tmp + rename, keeps .bak', async () => {
    const p = new MockPlatform();
    await p.ensureDir('/state');
    await atomicWriteJson('/state/x.json', { a: 1 }, p.fs);
    expect(JSON.parse((await p.fs.promises.readFile('/state/x.json')).toString())).toEqual({
      a: 1,
    });
    await atomicWriteJson('/state/x.json', { a: 2 }, p.fs);
    expect(JSON.parse((await p.fs.promises.readFile('/state/x.json')).toString())).toEqual({
      a: 2,
    });
    expect(JSON.parse((await p.fs.promises.readFile('/state/x.json.bak')).toString())).toEqual({
      a: 1,
    });
  });

  it('readJsonOrDefault returns default if missing', async () => {
    const p = new MockPlatform();
    expect(await readJsonOrDefault('/missing.json', () => ({ z: 0 }), p.fs)).toEqual({ z: 0 });
  });
});
