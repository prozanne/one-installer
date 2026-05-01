import { describe, it, expect } from 'vitest';
import { extractZipSafe, listZipEntries, checkEntryName } from '@main/packages/zip-safe';
import { makeZip } from '../helpers/make-zip';
import { MockPlatform } from '@main/platform';

describe('checkEntryName', () => {
  it('accepts plain relative paths', () => {
    expect(() => checkEntryName('a.txt')).not.toThrow();
    expect(() => checkEntryName('sub/b.txt')).not.toThrow();
  });

  it('rejects zip slip (../)', () => {
    expect(() => checkEntryName('../escape.txt')).toThrow(/zip slip/i);
    expect(() => checkEntryName('a/../../b.txt')).toThrow(/zip slip/i);
  });

  it('rejects absolute paths', () => {
    expect(() => checkEntryName('/abs/x.txt')).toThrow(/absolute/i);
    expect(() => checkEntryName('C:/abs/x.txt')).toThrow(/absolute/i);
  });

  it('rejects reserved Windows names', () => {
    expect(() => checkEntryName('CON.txt')).toThrow(/reserved/i);
    expect(() => checkEntryName('sub/COM1.dll')).toThrow(/reserved/i);
  });

  it('rejects trailing space/dot in component', () => {
    expect(() => checkEntryName('foo./bar.txt')).toThrow();
    expect(() => checkEntryName('foo /bar.txt')).toThrow();
  });
});

describe('extractZipSafe (happy paths)', () => {
  it('extracts plain files', async () => {
    const buf = await makeZip({ 'a.txt': 'hello', 'sub/b.txt': 'world' });
    const p = new MockPlatform();
    await p.ensureDir('/out');
    const result = await extractZipSafe({ zipBytes: buf, destDir: '/out', fs: p.fs });
    expect(result.files.sort()).toEqual(['a.txt', 'sub/b.txt']);
    expect((await p.fs.promises.readFile('/out/a.txt')).toString()).toBe('hello');
    expect((await p.fs.promises.readFile('/out/sub/b.txt')).toString()).toBe('world');
  });

  it('listZipEntries returns names without extracting', async () => {
    const buf = await makeZip({ 'a.txt': 'x', 'b.txt': 'y' });
    expect((await listZipEntries(buf)).sort()).toEqual(['a.txt', 'b.txt']);
  });
});
