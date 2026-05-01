/**
 * Real Win32 implementation of the `Platform` interface. Uses zero npm deps —
 * everything is shelled out to OS-bundled tooling (reg.exe, powershell.exe,
 * setx) or pure node:fs / node:child_process.
 *
 * Trade-offs:
 * - reg.exe round-trips are ~30–60ms each. Cheap for a few writes during
 *   install; would be a problem for thousands. Bulk-import via .reg files
 *   is the optimisation path if we ever measure this hot.
 * - PowerShell startup (~150–250ms first call) is paid per-shortcut. Future
 *   work: batch multiple shortcuts into one PS process.
 * - Direct registry writes for env PATH (not setx) so we can write
 *   REG_EXPAND_SZ instead of REG_SZ and avoid the 1024-char truncation
 *   setx imposes. We then broadcast WM_SETTINGCHANGE manually so running
 *   shells pick the change up.
 */
import { execFile } from 'node:child_process';
import { promises as fsP, createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
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

/**
 * Timeout for any non-`exec`-action PowerShell call (createShortcut,
 * broadcastEnvChange, diskFreeBytes). PowerShell COM activation under
 * aggressive AV (Defender ASR, CrowdStrike) can hang for tens of seconds
 * or indefinitely; without a timeout the caller hangs forever. 30s is
 * generous for first-run AOT compilation of `Add-Type` snippets and tight
 * for everything else.
 */
const PS_TIMEOUT_MS = 30_000;

interface WindowsPlatformOptions {
  /**
   * If true, allow HKLM writes / Program Files. The renderer only requests
   * elevation right before the elevated worker spawns; standard-user mode
   * defaults to `false` so HKLM mistakes fail loudly.
   */
  elevationGranted?: boolean;
}

const REG_VALUE_TYPE_TO_REGEXE: Record<RegistryValue['type'], string> = {
  REG_SZ: 'REG_SZ',
  REG_EXPAND_SZ: 'REG_EXPAND_SZ',
  REG_DWORD: 'REG_DWORD',
  REG_QWORD: 'REG_QWORD',
  REG_MULTI_SZ: 'REG_MULTI_SZ',
  REG_BINARY: 'REG_BINARY',
};

function regPathFor(hive: RegHive, key: string): string {
  return `${hive}\\${key.replace(/^\\+/, '')}`;
}

export class WindowsPlatform implements Platform {
  private readonly elevationGranted: boolean;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: WindowsPlatformOptions = {}) {
    this.elevationGranted = opts.elevationGranted ?? false;
    this.env = process.env;
  }

  systemVars() {
    const env = this.env;
    return buildSystemVars({
      programFiles: env['ProgramFiles'] ?? 'C:/Program Files',
      programFilesX86: env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)',
      localAppData: env['LOCALAPPDATA'] ?? 'C:/Users/Default/AppData/Local',
      desktop: join(env['USERPROFILE'] ?? '', 'Desktop').replace(/\\/g, '/'),
      startMenu: join(
        env['APPDATA'] ?? '',
        'Microsoft',
        'Windows',
        'Start Menu',
        'Programs',
      ).replace(/\\/g, '/'),
      temp: env['TEMP'] ?? tmpdir(),
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

  async diskFreeBytes(driveLetter: string): Promise<bigint> {
    try {
      const drive = driveLetter.replace(/[:\\/]+$/, '').toUpperCase();
      const { stdout } = await exec(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `(Get-PSDrive -Name ${drive} -PSProvider FileSystem).Free`,
        ],
        { timeout: PS_TIMEOUT_MS },
      );
      return BigInt(stdout.trim());
    } catch {
      return 1n << 60n;
    }
  }

  async createShortcut(input: ShortcutInput): Promise<void> {
    await fsP.mkdir(dirname(input.path), { recursive: true });
    const ps = [
      `$ws = New-Object -ComObject WScript.Shell`,
      `$lnk = $ws.CreateShortcut(${psQuote(input.path)})`,
      `$lnk.TargetPath = ${psQuote(input.target)}`,
      input.args ? `$lnk.Arguments = ${psQuote(input.args)}` : '',
      input.workingDir ? `$lnk.WorkingDirectory = ${psQuote(input.workingDir)}` : '',
      input.iconPath ? `$lnk.IconLocation = ${psQuote(input.iconPath)}` : '',
      input.description ? `$lnk.Description = ${psQuote(input.description)}` : '',
      `$lnk.Save()`,
    ]
      .filter(Boolean)
      .join('; ');
    await exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: PS_TIMEOUT_MS },
    );
  }

  async deleteShortcut(path: string): Promise<void> {
    try {
      await fsP.unlink(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }

  async registryKeyExists(hive: RegHive, key: string): Promise<boolean> {
    try {
      await exec('reg.exe', ['QUERY', regPathFor(hive, key)]);
      return true;
    } catch {
      return false;
    }
  }

  async registryRead(
    hive: RegHive,
    key: string,
    valueName: string,
  ): Promise<RegistryValue | null> {
    try {
      const { stdout } = await exec('reg.exe', [
        'QUERY',
        regPathFor(hive, key),
        '/v',
        valueName,
      ]);
      return parseRegQueryValue(stdout);
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
    const args = [
      'ADD',
      regPathFor(hive, key),
      '/v',
      valueName,
      '/t',
      REG_VALUE_TYPE_TO_REGEXE[value.type],
      '/d',
      value.type === 'REG_MULTI_SZ' && Array.isArray(value.data)
        ? value.data.join('\\0')
        : String(value.data),
      '/f',
    ];
    await exec('reg.exe', args);
  }

  async registryDeleteValue(hive: RegHive, key: string, valueName: string): Promise<void> {
    this.requireElevationFor(hive, 'registryDeleteValue');
    try {
      await exec('reg.exe', ['DELETE', regPathFor(hive, key), '/v', valueName, '/f']);
    } catch (e) {
      if (!/cannot find/i.test((e as Error).message)) throw e;
    }
  }

  async registryDeleteKey(hive: RegHive, key: string, recursive: boolean): Promise<void> {
    this.requireElevationFor(hive, 'registryDeleteKey');
    try {
      const args = ['DELETE', regPathFor(hive, key), '/f'];
      if (recursive) args.push('/va');
      await exec('reg.exe', args);
    } catch (e) {
      if (!/cannot find/i.test((e as Error).message)) throw e;
    }
  }

  async pathEnvAdd(scope: 'user' | 'machine', dir: string): Promise<void> {
    if (scope === 'machine') this.requireElevationFor('HKLM', 'pathEnvAdd');
    const hive: RegHive = scope === 'user' ? 'HKCU' : 'HKLM';
    const key =
      scope === 'user'
        ? 'Environment'
        : 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
    const cur = await this.registryRead(hive, key, 'Path');
    const existing = cur && cur.type !== 'REG_BINARY' ? String(cur.data) : '';
    const parts = existing.split(';').map((s) => s.trim()).filter(Boolean);
    if (parts.includes(dir)) return;
    parts.push(dir);
    await this.registryWrite(hive, key, 'Path', {
      type: 'REG_EXPAND_SZ',
      data: parts.join(';'),
    });
    await this.broadcastEnvChange();
  }

  async pathEnvRemove(scope: 'user' | 'machine', dir: string): Promise<void> {
    if (scope === 'machine') this.requireElevationFor('HKLM', 'pathEnvRemove');
    const hive: RegHive = scope === 'user' ? 'HKCU' : 'HKLM';
    const key =
      scope === 'user'
        ? 'Environment'
        : 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
    const cur = await this.registryRead(hive, key, 'Path');
    const existing = cur && cur.type !== 'REG_BINARY' ? String(cur.data) : '';
    const parts = existing
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s && s !== dir);
    await this.registryWrite(hive, key, 'Path', {
      type: 'REG_EXPAND_SZ',
      data: parts.join(';'),
    });
    await this.broadcastEnvChange();
  }

  /**
   * Broadcast WM_SETTINGCHANGE so already-running shells pick up env changes
   * without a relogin. Best-effort — some cmd.exe instances ignore the
   * broadcast and still need to be restarted.
   */
  private async broadcastEnvChange(): Promise<void> {
    try {
      const ps = [
        '$sig = "[DllImport(\\"user32.dll\\", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);"',
        '$type = Add-Type -MemberDefinition $sig -Name Win32SendMessageTimeout -Namespace VdxBroadcast -PassThru',
        '$HWND_BROADCAST = [intptr]0xffff',
        '$WM_SETTINGCHANGE = 0x1a',
        '$result = [uintptr]::Zero',
        '$type::SendMessageTimeout($HWND_BROADCAST, $WM_SETTINGCHANGE, [intptr]::Zero, "Environment", 2, 5000, [ref]$result) | Out-Null',
      ].join('; ');
      await exec(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
        { timeout: PS_TIMEOUT_MS },
      );
    } catch {
      /* best-effort */
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
          env: { ...this.env, ...input.env },
          timeout: input.timeoutMs,
          windowsHide: true,
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
            stdout: stdoutToString(stdout),
            stderr: stdoutToString(stderr),
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
      const exeName = exePath.split(/[\\/]/).pop() ?? exePath;
      const { stdout } = await exec('tasklist.exe', [
        '/FI',
        `IMAGENAME eq ${exeName}`,
        '/FO',
        'CSV',
        '/NH',
      ]);
      const m = stdout.match(/"[^"]*","(\d+)"/);
      if (m) return { running: true, pid: Number(m[1]) };
      return { running: false };
    } catch {
      return { running: false };
    }
  }

  async isPidAlive(pid: number): Promise<boolean> {
    try {
      // Signal 0 = liveness probe. Throws ESRCH if the PID is gone.
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private requireElevationFor(hive: RegHive | 'HKLM', op: string): void {
    if (hive === 'HKLM' && !this.elevationGranted) {
      const err = new Error(`${op} on HKLM requires elevation`);
      err.name = 'PermissionError';
      throw err;
    }
  }
}

/**
 * `execFile`'s `(stdout, stderr)` callback args are typed as `string | Buffer`
 * by default but TypeScript narrows them to `never` here through the option
 * literal — this helper coerces both shapes safely.
 */
function stdoutToString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof (v as { toString?: () => string }).toString === 'function') {
    return (v as Buffer).toString('utf8');
  }
  return '';
}

/**
 * Quote a string for safe inclusion in a single-line PowerShell command.
 * PS uses single quotes for verbatim strings; doubling internal single quotes
 * escapes them. We only ever pass paths and manifest fields through here —
 * never raw user input.
 */
function psQuote(s: string): string {
  // Strip CR / LF / TAB before quoting. PowerShell single-quoted strings span
  // newlines literally, but our PS scripts join statements with `; ` into a
  // single `-Command` argument; a literal newline inside a quoted operand can
  // confuse cmdline tokenization on some PS hosts and changes how `; `
  // separators are interpreted. Manifest schema's NoControlChars constraint
  // already rejects these for shortcut.target/args/etc, so this is belt-and-
  // suspenders for whatever future caller sneaks past the schema.
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\r\n\t\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  return `'${cleaned.replace(/'/g, "''")}'`;
}

/**
 * Parse `reg.exe QUERY` output for a single value into a RegistryValue.
 * Output shape (one line per value):
 *   `    SomeName    REG_SZ    actual data`
 * Whitespace-delimited but the data segment may contain whitespace; capture
 * with three columns + non-greedy last column.
 */
function parseRegQueryValue(stdout: string): RegistryValue | null {
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s+(\S+)\s+(REG_[A-Z_]+)\s+(.*)$/);
    if (!m) continue;
    const type = m[2] as RegistryValue['type'];
    const raw = m[3] ?? '';
    if (type === 'REG_DWORD' || type === 'REG_QWORD') {
      return { type, data: raw.startsWith('0x') ? parseInt(raw, 16) : Number(raw) };
    }
    if (type === 'REG_MULTI_SZ') {
      return { type, data: raw.split('\\0').filter(Boolean) };
    }
    return { type, data: raw };
  }
  return null;
}
