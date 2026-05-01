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

  it('falls back to copy+delete when rename throws EXDEV', async () => {
    const p = new MockPlatform();
    await p.ensureDir('/state');
    // Establish a prior good state so .bak ends up populated.
    await atomicWriteJson('/state/x.json', { a: 1 }, p.fs);

    // Wrap fs.promises.rename to throw EXDEV on the next call only.
    const realRename = p.fs.promises.rename.bind(p.fs.promises);
    let renameCalls = 0;
    const fsProxy = new Proxy(p.fs, {
      get(target, prop) {
        if (prop === 'promises') {
          return new Proxy(target.promises, {
            get(t2, p2) {
              if (p2 === 'rename') {
                return async (from: string, to: string) => {
                  renameCalls++;
                  if (renameCalls === 1) {
                    const err = new Error('EXDEV: cross-device link') as NodeJS.ErrnoException;
                    err.code = 'EXDEV';
                    throw err;
                  }
                  return realRename(from, to);
                };
              }
              return Reflect.get(t2, p2);
            },
          });
        }
        return Reflect.get(target, prop);
      },
    });

    const fallbacks: { path: string; code: string }[] = [];
    await atomicWriteJson(
      '/state/x.json',
      { a: 2 },
      fsProxy as typeof p.fs,
      { onCrossVolumeFallback: (info) => fallbacks.push(info) },
    );

    expect(JSON.parse((await p.fs.promises.readFile('/state/x.json')).toString())).toEqual({
      a: 2,
    });
    expect(JSON.parse((await p.fs.promises.readFile('/state/x.json.bak')).toString())).toEqual({
      a: 1,
    });
    expect(fallbacks).toEqual([{ path: '/state/x.json', code: 'EXDEV' }]);
    // tmp must not linger after fallback.
    await expect(p.fs.promises.access('/state/x.json.tmp')).rejects.toThrow();
  });

  it('rethrows non-EXDEV rename errors', async () => {
    const p = new MockPlatform();
    await p.ensureDir('/state');
    const fsProxy = new Proxy(p.fs, {
      get(target, prop) {
        if (prop === 'promises') {
          return new Proxy(target.promises, {
            get(t2, p2) {
              if (p2 === 'rename') {
                return async () => {
                  const err = new Error('EACCES') as NodeJS.ErrnoException;
                  err.code = 'EACCES';
                  throw err;
                };
              }
              return Reflect.get(t2, p2);
            },
          });
        }
        return Reflect.get(target, prop);
      },
    });
    await expect(
      atomicWriteJson('/state/x.json', { a: 1 }, fsProxy as typeof p.fs),
    ).rejects.toThrow(/EACCES/);
  });
});
