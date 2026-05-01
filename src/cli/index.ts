#!/usr/bin/env node
/**
 * VDX CLI — apt-get-style entry point.
 *
 * Subcommands (mirrors apt-get vocabulary):
 *
 *   vdx install <id|file.vdxpkg>
 *   vdx remove  <id>
 *   vdx upgrade [<id>] [--all]
 *   vdx list    [--installed] [--agents] [--json]
 *   vdx search  <query>      [--agents] [--json]
 *   vdx info    <id>          [--json]
 *   vdx sync    [--dry-run] [--yes]
 *   vdx export  [<file>]
 *   vdx import  <file>
 *
 * Common flags:
 *   --yes, -y     Skip confirmation prompts (CI / scripted use)
 *   --json        Machine-readable output where applicable
 *   --agents      Operate on the agent catalog instead of the app catalog
 *
 * Exit codes follow apt-get convention: 0 success, 1 user error /
 * "nothing to do", 100 hard host error.
 */
import { bootCliHost } from './host-bootstrap';
import { c, println } from './output';
import { cmdInstall } from './commands/install';
import { cmdRemove } from './commands/remove';
import { cmdList } from './commands/list';
import { cmdInfo } from './commands/info';
import { cmdSearch } from './commands/search';
import { cmdUpgrade } from './commands/upgrade';
import { cmdSync } from './commands/sync';
import { cmdExport, cmdImport } from './commands/state';

const HOST_VERSION = '0.1.0-dev';

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Set<string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const positional: string[] = [];
  let command = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      flags.add(a);
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      // Single-letter shorts.
      for (const ch of a.slice(1)) flags.add(`-${ch}`);
      continue;
    }
    if (!command) command = a;
    else positional.push(a);
  }
  return { command, positional, flags };
}

function hasFlag(args: ParsedArgs, ...names: string[]): boolean {
  return names.some((n) => args.flags.has(n));
}

function help(): void {
  println(c.bold('vdx — VDX Installer CLI (apt-get style)'));
  println('');
  println(c.bold('Commands:'));
  println('  install <id|file>       Install from catalog or sideload .vdxpkg');
  println('  remove  <id>            Uninstall an app');
  println('  upgrade [<id>] [--all]  Upgrade installed apps');
  println('  list    [--installed]   List catalog or installed apps');
  println('  search  <query>         Search the catalog');
  println('  info    <id>            Show details for an app');
  println('  sync    [--dry-run]     Apply Fleet Profile reconcile');
  println('  export  [<file>]        Export installed-state JSON');
  println('  import  <file>          Import installed-state JSON');
  println('');
  println(c.bold('Common flags:'));
  println('  --yes, -y               Skip confirmation prompts');
  println('  --json                  Machine-readable output');
  println('  --agents                Use the agent catalog');
  println('  --version               Print version and exit');
  println('  --help, -h              Show this help');
}

async function runCommand(args: ParsedArgs): Promise<number> {
  if (hasFlag(args, '--version')) {
    println(`vdx ${HOST_VERSION}`);
    return 0;
  }
  if (hasFlag(args, '--help', '-h') || !args.command) {
    help();
    return 0;
  }

  const yes = hasFlag(args, '--yes', '-y');
  const json = hasFlag(args, '--json');
  const kind: 'app' | 'agent' = hasFlag(args, '--agents') ? 'agent' : 'app';

  let host;
  try {
    host = await bootCliHost();
  } catch (e) {
    println(c.red(`Host bootstrap failed: ${(e as Error).message}`));
    return 100;
  }

  switch (args.command) {
    case 'install':
    case 'i': {
      const appId = args.positional[0];
      if (!appId) {
        println(c.red('Usage: vdx install <id|file.vdxpkg>'));
        return 1;
      }
      return cmdInstall(host, { appId, kind, yes });
    }
    case 'remove':
    case 'rm': {
      const appId = args.positional[0];
      if (!appId) {
        println(c.red('Usage: vdx remove <id>'));
        return 1;
      }
      return cmdRemove(host, { appId, yes });
    }
    case 'upgrade':
    case 'up': {
      return cmdUpgrade(host, {
        ...(args.positional[0] !== undefined && { appId: args.positional[0] }),
        all: hasFlag(args, '--all'),
        yes,
      });
    }
    case 'list':
    case 'ls': {
      return cmdList(host, {
        installed: hasFlag(args, '--installed'),
        kind,
        json,
      });
    }
    case 'search': {
      const query = args.positional.join(' ');
      if (!query) {
        println(c.red('Usage: vdx search <query>'));
        return 1;
      }
      return cmdSearch(host, { query, kind, json });
    }
    case 'info':
    case 'show': {
      const appId = args.positional[0];
      if (!appId) {
        println(c.red('Usage: vdx info <id>'));
        return 1;
      }
      return cmdInfo(host, { appId, kind, json });
    }
    case 'sync': {
      return cmdSync(host, { dryRun: hasFlag(args, '--dry-run'), yes });
    }
    case 'export': {
      return cmdExport(host, { file: args.positional[0] ?? null });
    }
    case 'import': {
      const file = args.positional[0];
      if (!file) {
        println(c.red('Usage: vdx import <file>'));
        return 1;
      }
      return cmdImport(host, { file });
    }
    default: {
      println(c.red(`Unknown command: ${args.command}`));
      help();
      return 1;
    }
  }
}

export async function main(argv: string[]): Promise<number> {
  return runCommand(parseArgs(argv));
}

// Direct invocation guard.
const isMain =
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (require as any).main === module;

if (isMain || process.argv[1]?.endsWith('cli/index.ts') || process.argv[1]?.endsWith('cli.js')) {
  void main(process.argv.slice(2)).then((rc) => process.exit(rc));
}
