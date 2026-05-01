import type { IFs } from 'memfs';
import * as nodeFs from 'node:fs';

type FsLike = IFs | typeof nodeFs;

export async function atomicWriteJson(
  path: string,
  data: unknown,
  fs: FsLike = nodeFs,
): Promise<void> {
  const tmp = `${path}.tmp`;
  const bak = `${path}.bak`;
  const json = JSON.stringify(data, null, 2);
  await (fs as IFs).promises.writeFile(tmp, json);
  try {
    await (fs as IFs).promises.copyFile(path, bak);
  } catch {
    // no existing — ignore
  }
  await (fs as IFs).promises.rename(tmp, path);
}

export async function readJsonOrDefault<T>(
  path: string,
  defaultValue: () => T,
  fs: FsLike = nodeFs,
): Promise<T> {
  try {
    const buf = await (fs as IFs).promises.readFile(path);
    return JSON.parse(buf.toString()) as T;
  } catch {
    return defaultValue();
  }
}
