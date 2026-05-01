/**
 * Real Linux implementation of the `Platform` interface. Lets the engine
 * install / uninstall the same manifests on Linux that work on Windows
 * without any per-platform manifest tags.
 *
 * Strategy choices and trade-offs:
 *
 * - **Registry**: Linux has no Windows-style registry. We back it with a
 *   JSON file per (hive, key) pair under
 *     HKCU → ~/.config/vdx-installer/registry-shim/HKCU/<key path>.json
 *     HKLM → /etc/vdx-installer/registry-shim/HKLM/<key path>.json (root)
 *   `\` separators in the manifest are normalised to `/`. The shim is
 *   *only* read/written by us — nothing on the system reads from it. Apps
 *   that need cross-platform "registry-like" config should read it back
 *   through a small helper at runtime if portability matters.
 *
 * - **Shortcuts**: freedesktop.org `.desktop` files. `desktop` →
 *   ~/Desktop/<name>.desktop, `startMenu` / `programs` →
 *   ~/.local/share/applications/<name>.desktop. The latter is what the
 *   GNOME / KDE app launcher reads.
 *
 * - **PATH**: append the line `export PATH="<dir>:$PATH"` to ~/.profile,
 *   bracketed by VDX-managed marker comments so we can find it again on
 *   uninstall. Shell-rc files (.bashrc / .zshrc / fish) are intentionally
 *   not touched — the user's shell config is theirs to own.
 *
 * - **Exec**: child_process.execFile, no shell. Same hash-pinning gate as
 *   the Windows path runs in `post-install/exec.ts` (engine-side).
 *
 * - **ARP**: no Linux equivalent; the engine's installed.json is the only
 *   record. Uninstall through the host UI works exactly like Windows.
 *
 * - **Process liveness**: `process.kill(pid, 0)` works identically to the
 *   Windows path — no platform branch needed.
 */
import { execFile } from 'node:child_process';
import {
  promises as fsP,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  createReadStream,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { buildSystemVars } from './system-paths';
import type {
  ExecInput,
  ExecResult,
  Platform,
  RegHive,
  RegistryValue,
  ShortcutInput,
} from './types';

const exec = promisify(execFile);

interface LinuxPlatformOptions {
  /**
   * If true, allow HKLM-equivalent writes (under /etc). Standard-user mode
   * defaults to false so attempts to escalate fail loudly. The elevated
   * worker is the only caller that should set this true.
   */
  elevationGranted?: boolean;
  /**
   * Override $HOME for tests. Production omits.
   */
  home?: string;
}

const PROFILE_BEGIN = '# >>> vdx-installer managed PATH (do not edit) >>>';
const PROFILE_END = '# <<< vdx-installer managed PATH <<<';

export class LinuxPlatform implements Platform {
  private readonly elevationGranted: boolean;
  private readonly home: string;

  constructor(opts: LinuxPlatformOptions = {}) {
    this.elevationGranted = opts.elevationGranted ?? false;
    this.home = opts.home ?? homedir();
  }

  systemVars() {
    return buildSystemVars({
      // Linux has no Program Files; we map to /opt for `machine` scope and
      // ~/.local/share for `user` scope, mirroring Windows convention but
      // through XDG paths. Manifests using `{ProgramFiles}` end up under
      // /opt/Samsung/<App>; users can override by setting an explicit
      // installPath in the wizard's path step.
      programFiles: '/opt',
      programFilesX86: '/opt',
      localAppData: join(this.home, '.local', 'share'),
      desktop: join(this.home, 'Desktop'),
      // Linux has no Start Menu; we use the freedesktop application
      // directory which is what every modern DE's launcher reads.
      startMenu: join(this.home, '.local', 'share', 'applications'),
      temp: tmpdir(),
      installerVersion: '0.1.0-dev',
      appId: '',
      appVersion: '',
    });
  }

  async pathExists(p: string): Promise<boolean> {
    try {
      await fsP.access(p);
      return true;
    } catch {
      return false;
    }
  }

  async ensureDir(p: string): Promise<void> {
    await fsP.mkdir(p, { recursive: true });
  }

  async rmDir(p: string, opts?: { recursive: boolean }): Promise<void> {
    await fsP.rm(p, { recursive: opts?.recursive ?? false, force: true });
  }

  async rmFile(p: string): Promise<void> {
    await fsP.unlink(p);
  }

  async moveFile(from: string, to: string, opts?: { overwrite?: boolean }): Promise<void> {
    await fsP.mkdir(dirname(to), { recursive: true });
    if (!(opts?.overwrite ?? false)) {
      try {
        await fsP.access(to);
        throw new Error(`Destination exists: ${to}`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    try {
      await fsP.rename(from, to);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
        await fsP.copyFile(from, to);
        await fsP.unlink(from);
      } else {
        throw e;
      }
    }
  }

  async diskFreeBytes(_driveLetter: string): Promise<bigint> {
    // POSIX: statvfs via shell (df). f_bavail × f_frsize. df reports KiB
    // by default which is fine for our 4 GiB-ish budgeting.
    try {
      const target = this.home;
      const { stdout } = await exec('df', ['-Pk', target]);
      const last = stdout.trim().split('\n').pop() ?? '';
      const cols = last.split(/\s+/);
      const availKib = Number(cols[3] ?? '0');
      if (!Number.isFinite(availKib)) return 1n << 60n;
      return BigInt(availKib) * 1024n;
    } catch {
      return 1n << 60n;
    }
  }

  async createShortcut(input: ShortcutInput): Promise<void> {
    await fsP.mkdir(dirname(input.path), { recursive: true });
    // .desktop file — keys per https://specifications.freedesktop.org/desktop-entry-spec/
    // A .lnk path passed in (`...lnk`) is honored as-is so the engine's
    // shortcut handler doesn't need to know it's writing for Linux; we
    // just always emit .desktop content regardless of the extension.
    const desktopPath = input.path.endsWith('.desktop')
      ? input.path
      : input.path.replace(/\.lnk$/, '.desktop');
    const lines = [
      '[Desktop Entry]',
      'Type=Application',
      `Name=${escapeDesktop(input.description ?? input.path.split('/').pop() ?? 'App')}`,
      `Exec=${escapeDesktop(quoteIfSpaces(input.target))}${input.args ? ` ${input.args}` : ''}`,
      ...(input.workingDir ? [`Path=${escapeDesktop(input.workingDir)}`] : []),
      ...(input.iconPath ? [`Icon=${escapeDesktop(input.iconPath)}`] : []),
      'Terminal=false',
      'Categories=Utility;',
      '',
    ];
    await fsP.writeFile(desktopPath, lines.join('\n'), { mode: 0o755 });
  }

  async deleteShortcut(path: string): Promise<void> {
    const desktopPath = path.endsWith('.desktop') ? path : path.replace(/\.lnk$/, '.desktop');
    try {
      await fsP.unlink(desktopPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }

  async registryKeyExists(hive: RegHive, key: string): Promise<boolean> {
    return existsSync(this.shimPath(hive, key));
  }

  async registryRead(
    hive: RegHive,
    key: string,
    valueName: string,
  ): Promise<RegistryValue | null> {
    const path = this.shimPath(hive, key);
    if (!existsSync(path)) return null;
    try {
      const obj = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, RegistryValue>;
      return obj[valueName] ?? null;
    } catch {
      return null;
    }
  }

  async registryWrite(
    hive: RegHive,
    key: string,
    valueName: string,
    value: RegistryValue,
  ): Promise<void> {
    this.requireElevationFor(hive, 'registryWrite');
    const path = this.shimPath(hive, key);
    mkdirSync(dirname(path), { recursive: true });
    let obj: Record<string, RegistryValue> = {};
    if (existsSync(path)) {
      try {
        obj = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, RegistryValue>;
      } catch {
        obj = {};
      }
    }
    obj[valueName] = value;
    writeFileSync(path, JSON.stringify(obj, null, 2), { mode: 0o644 });
  }

  async registryDeleteValue(hive: RegHive, key: string, valueName: string): Promise<void> {
    this.requireElevationFor(hive, 'registryDeleteValue');
    const path = this.shimPath(hive, key);
    if (!existsSync(path)) return;
    try {
      const obj = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, RegistryValue>;
      delete obj[valueName];
      if (Object.keys(obj).length === 0) {
        unlinkSync(path);
      } else {
        writeFileSync(path, JSON.stringify(obj, null, 2), { mode: 0o644 });
      }
    } catch {
      /* idempotent */
    }
  }

  async registryDeleteKey(hive: RegHive, key: string, recursive: boolean): Promise<void> {
    this.requireElevationFor(hive, 'registryDeleteKey');
    const path = this.shimPath(hive, key);
    if (recursive) {
      // Drop the JSON file AND any subkeys whose path starts with this key.
      const baseDir = path.replace(/\.json$/, '');
      try {
        await fsP.rm(baseDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(path);
      } catch {
        /* ignore */
      }
    } else {
      try {
        unlinkSync(path);
      } catch {
        /* idempotent */
      }
    }
  }

  async pathEnvAdd(scope: 'user' | 'machine', dir: string): Promise<void> {
    if (scope === 'machine') this.requireElevationFor('HKLM', 'pathEnvAdd');
    const profile = this.profilePath(scope);
    const block = this.readProfileBlock(profile);
    if (block.entries.includes(dir)) return; // idempotent
    block.entries.push(dir);
    this.writeProfileBlock(profile, block.entries);
  }

  async pathEnvRemove(scope: 'user' | 'machine', dir: string): Promise<void> {
    if (scope === 'machine') this.requireElevationFor('HKLM', 'pathEnvRemove');
    const profile = this.profilePath(scope);
    const block = this.readProfileBlock(profile);
    const next = block.entries.filter((e) => e !== dir);
    if (next.length === 0) {
      // Drop the marker block entirely if no entries remain — leaves the
      // user's profile clean.
      this.writeProfileBlock(profile, []);
    } else {
      this.writeProfileBlock(profile, next);
    }
  }

  async exec(input: ExecInput): Promise<ExecResult> {
    const start = Date.now();
    return new Promise<ExecResult>((resolve) => {
      const child = execFile(
        input.cmd,
        input.args,
        {
          cwd: input.cwd,
          env: { ...process.env, ...input.env },
          timeout: input.timeoutMs,
          maxBuffer: 64 * 1024,
        },
        (err, stdout, stderr) => {
          const durationMs = Date.now() - start;
          const timedOut = !!err && (err as NodeJS.ErrnoException).code === 'ETIMEDOUT';
          const exitCode = err
            ? (err as NodeJS.ErrnoException).code === 'ETIMEDOUT'
              ? -1
              : (child.exitCode ?? 1)
            : 0;
          resolve({
            exitCode,
            stdout: typeof stdout === 'string' ? stdout : Buffer.from(stdout as ArrayBufferLike).toString('utf8'),
            stderr: typeof stderr === 'string' ? stderr : Buffer.from(stderr as ArrayBufferLike).toString('utf8'),
            durationMs,
            timedOut,
          });
        },
      );
    });
  }

  async fileSha256(path: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = createReadStream(path);
      stream.on('data', (c) => hash.update(c));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  async isProcessRunning(exePath: string): Promise<{ running: boolean; pid?: number }> {
    try {
      // pgrep -f matches against the full command line — needed because
      // the running process name is often `electron` not the user-visible
      // exe path. False positives possible but acceptable.
      const exeName = exePath.split('/').pop() ?? exePath;
      const { stdout } = await exec('pgrep', ['-f', exeName]);
      const first = stdout.trim().split('\n')[0];
      if (!first) return { running: false };
      const pid = Number(first);
      if (!Number.isFinite(pid)) return { running: false };
      return { running: true, pid };
    } catch {
      return { running: false };
    }
  }

  async isPidAlive(pid: number): Promise<boolean> {
    try {
      // POSIX: signal 0 is liveness probe; throws ESRCH on dead pid.
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private requireElevationFor(hive: RegHive | 'HKLM', op: string): void {
    if (hive === 'HKLM' && !this.elevationGranted) {
      const err = new Error(`${op} on HKLM (Linux: /etc) requires elevation`);
      err.name = 'PermissionError';
      throw err;
    }
  }

  /**
   * Convert a Windows-style registry key path to a JSON file path under
   * the per-hive shim root. `Software\Samsung\X` → `Software/Samsung/X.json`.
   * Single backslash, double backslash, and forward slash are all accepted
   * as separators since manifest authors are inconsistent.
   */
  private shimPath(hive: RegHive, key: string): string {
    const root =
      hive === 'HKCU'
        ? join(this.home, '.config', 'vdx-installer', 'registry-shim', 'HKCU')
        : '/etc/vdx-installer/registry-shim/HKLM';
    const normalized = key.replace(/\\+/g, '/').replace(/^\/+/, '');
    return join(root, `${normalized}.json`);
  }

  private profilePath(scope: 'user' | 'machine'): string {
    return scope === 'user'
      ? join(this.home, '.profile')
      : '/etc/profile.d/vdx-installer.sh';
  }

  /**
   * Parse the VDX-managed marker block out of a profile file. Returns the
   * list of directories the block currently exports, or [] if no block
   * exists. The user's other content in the same file is left untouched.
   */
  private readProfileBlock(profile: string): { entries: string[] } {
    if (!existsSync(profile)) return { entries: [] };
    const body = readFileSync(profile, 'utf-8');
    const start = body.indexOf(PROFILE_BEGIN);
    const end = body.indexOf(PROFILE_END);
    if (start === -1 || end === -1 || end < start) return { entries: [] };
    const block = body.slice(start + PROFILE_BEGIN.length, end);
    const entries: string[] = [];
    for (const line of block.split('\n')) {
      const m = line.match(/^export PATH="([^"]+):\$PATH"$/);
      if (m && m[1]) entries.push(m[1]);
    }
    return { entries };
  }

  /**
   * Replace the marker block in `profile` with one line per `entries`. If
   * `entries` is empty, the marker block is removed entirely so the file
   * looks like we were never here.
   */
  private writeProfileBlock(profile: string, entries: string[]): void {
    const exists = existsSync(profile);
    const original = exists ? readFileSync(profile, 'utf-8') : '';
    const start = original.indexOf(PROFILE_BEGIN);
    const end = original.indexOf(PROFILE_END);

    let withoutBlock = original;
    if (start !== -1 && end !== -1 && end > start) {
      const blockEnd = end + PROFILE_END.length;
      // Drop one trailing newline so we don't leave a blank line behind.
      const tail = original[blockEnd] === '\n' ? blockEnd + 1 : blockEnd;
      withoutBlock = original.slice(0, start) + original.slice(tail);
    }
    // Trim trailing newlines from the user's content; we always append our
    // own controlled \n separators.
    withoutBlock = withoutBlock.replace(/\n+$/, '');

    let next: string;
    if (entries.length === 0) {
      next = withoutBlock + (withoutBlock ? '\n' : '');
    } else {
      const lines = [
        PROFILE_BEGIN,
        ...entries.map((d) => `export PATH="${d}:$PATH"`),
        PROFILE_END,
      ].join('\n');
      next = (withoutBlock ? withoutBlock + '\n\n' : '') + lines + '\n';
    }
    if (next === original) return; // mtime preservation
    mkdirSync(dirname(profile), { recursive: true });
    writeFileSync(profile, next, { mode: 0o644 });
  }
}

/** Escape characters that would break the .desktop key=value format. */
function escapeDesktop(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, ' ');
}

/** Quote `path` if it contains whitespace — Exec= splits on space. */
function quoteIfSpaces(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}
