import type { IFs } from 'memfs';
import * as nodeFs from 'node:fs';
import { ok, err, type Result } from '@shared/types';

type FsLike = IFs | typeof nodeFs;

export interface AppLock {
  release(): Promise<void>;
}

export async function acquireAppLock(
  lockDir: string,
  appId: string,
  fs: FsLike = nodeFs,
): Promise<Result<AppLock, string>> {
  const fsP = (fs as IFs).promises;
  await fsP.mkdir(lockDir, { recursive: true });
  const path = `${lockDir}/${appId}.lock`;
  try {
    const handle = await fsP.open(path, 'wx');
    await handle.writeFile(`pid=${process.pid}\nat=${new Date().toISOString()}\n`);
    await handle.close();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return err(`Lock busy: ${appId}`);
    return err((e as Error).message);
  }
  return ok({
    async release() {
      try {
        await fsP.unlink(path);
      } catch {
        /* idempotent */
      }
    },
  });
}
