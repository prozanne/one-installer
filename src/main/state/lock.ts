import type { IFs } from 'memfs';
import * as nodeFs from 'node:fs';
import { ok, err, type Result } from '@shared/types';

type FsLike = IFs | typeof nodeFs;

export interface AppLock {
  release(): Promise<void>;
}

/**
 * `pid=<n>\nat=<iso>\n` — written atomically by `wx`-create + writeFile.
 * A torn lockfile (writer crashed mid-write) leaves an empty or partial body;
 * `parseLockBody` returns null and the caller treats it as stale.
 */
function parseLockBody(body: string): { pid: number } | null {
  const m = body.match(/^pid=(\d+)/m);
  if (!m) return null;
  const pid = Number(m[1]);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return { pid };
}

export interface AcquireOptions {
  /**
   * Returns true if the given PID currently maps to a live process.
   * When provided, `acquireAppLock` recovers from lockfiles abandoned by a
   * crashed host: if the recorded PID is dead (or unparseable), the stale
   * file is removed and acquisition is retried once.
   *
   * Omit in tests that exercise pure exclusivity semantics; the lock is then
   * never recovered and only `release()` frees it.
   */
  isPidAlive?: (pid: number) => Promise<boolean>;
  /**
   * Optional warn-level callback fired when a stale lock is reclaimed.
   * Production wires this to the structured logger.
   */
  onStaleLockRecovered?: (info: { path: string; staleBody: string }) => void;
}

export async function acquireAppLock(
  lockDir: string,
  appId: string,
  fs: FsLike = nodeFs,
  opts: AcquireOptions = {},
): Promise<Result<AppLock, string>> {
  const fsP = (fs as IFs).promises;
  await fsP.mkdir(lockDir, { recursive: true });
  const path = `${lockDir}/${appId}.lock`;

  const tryCreate = async (): Promise<Result<AppLock, string> | 'busy'> => {
    try {
      const handle = await fsP.open(path, 'wx');
      await handle.writeFile(`pid=${process.pid}\nat=${new Date().toISOString()}\n`);
      await handle.close();
      return ok({
        async release() {
          try {
            await fsP.unlink(path);
          } catch {
            /* idempotent */
          }
        },
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return 'busy';
      return err((e as Error).message);
    }
  };

  const first = await tryCreate();
  if (first !== 'busy') return first;

  // Lockfile already exists. If the caller didn't supply liveness, the lock
  // is owned by something we can't reason about — treat as busy.
  if (!opts.isPidAlive) return err(`Lock busy: ${appId}`);

  let body = '';
  try {
    body = (await fsP.readFile(path)).toString();
  } catch {
    // Lockfile vanished between EEXIST and readFile — race with another
    // releaser. Retrying once is safe.
  }
  const parsed = parseLockBody(body);
  const stale = parsed === null || !(await opts.isPidAlive(parsed.pid));
  if (!stale) return err(`Lock busy: ${appId}`);

  try {
    await fsP.unlink(path);
  } catch {
    // Another process may have cleaned it up first.
  }
  opts.onStaleLockRecovered?.({ path, staleBody: body });

  const second = await tryCreate();
  if (second === 'busy') return err(`Lock busy: ${appId}`);
  return second;
}
