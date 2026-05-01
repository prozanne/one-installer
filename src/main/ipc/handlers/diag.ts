/**
 * Pure diagnostic IPC handlers — extracted from `electron-main.ts`.
 *
 * Both handlers reach into Electron `shell` to surface a path to the user;
 * the abstraction here keeps the path string from ever crossing the IPC
 * boundary back to the renderer. Tests inject a fake `DiagShell` and assert
 * what the handler tried to open.
 */
import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import * as yazl from 'yazl';
import {
  DiagExportReq,
  DiagOpenLogsReq,
  type DiagExportResT,
  type DiagOpenLogsResT,
} from '@shared/ipc-types';

/**
 * The slice of Electron's `shell` we need. Defining it here lets tests pass
 * a vi.fn() pair and inspect what the handler asked the OS to do — without
 * importing electron from a non-electron test process.
 */
export interface DiagShell {
  showItemInFolder(path: string): void;
  openPath(path: string): Promise<string>;
}

export interface DiagHandlerDeps {
  paths: { cacheDir: string; logsDir: string };
  shell: DiagShell;
  /** Override for tests. Defaults to `() => Date.now()`. */
  now?: () => number;
}

export async function handleDiagExport(
  deps: DiagHandlerDeps,
  raw: unknown,
): Promise<DiagExportResT> {
  const parsed = DiagExportReq.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, error: 'invalid request' };
  const ts = (deps.now ?? Date.now)();
  try {
    const archivePath = join(deps.paths.cacheDir, `vdx-diag-${ts}.zip`);
    await new Promise<void>((resolve, reject) => {
      const zipFile = new yazl.ZipFile();
      const outStream = createWriteStream(archivePath);
      zipFile.outputStream.pipe(outStream);
      outStream.on('close', resolve);
      outStream.on('error', reject);
      zipFile.outputStream.on('error', reject);

      void (async () => {
        try {
          const logFiles = await readdir(deps.paths.logsDir);
          for (const name of logFiles) {
            if (!name.endsWith('.log') && !name.endsWith('.ndjson')) continue;
            zipFile.addFile(join(deps.paths.logsDir, name), `logs/${name}`);
          }
        } catch {
          // logsDir may not yet have files — not fatal.
        }
        zipFile.end();
      })();
    });
    // Reveal in OS file manager from main; the path never crosses IPC back to
    // the renderer (one-way trust boundary).
    deps.shell.showItemInFolder(archivePath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function handleDiagOpenLogs(
  deps: DiagHandlerDeps,
  raw: unknown,
): Promise<DiagOpenLogsResT> {
  const parsed = DiagOpenLogsReq.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'invalid request' };
  try {
    await deps.shell.openPath(deps.paths.logsDir);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
