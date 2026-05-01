#!/usr/bin/env tsx
/**
 * Pre-commit / CI gate: forbid hardcoded archive-source strings outside the
 * single intentional location in `config-defaults.ts`. See
 * `docs/superpowers/specs/2026-05-01-package-source-abstraction.md` §6.2.
 *
 * Any reference to the GitHub catalog repo, releases repo, or api.github.com
 * elsewhere in `src/` is a defect: source is supposed to be config-driven so
 * mirror swapping does not require a recompile.
 *
 * Exit code 0 = clean. Exit code 1 = at least one offending match.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIR = join(ROOT, 'src');
const ALLOWED_FILE = join('src', 'main', 'source', 'config-defaults.ts');

const FORBIDDEN_PATTERNS: RegExp[] = [
  /samsung\/vdx-catalog/,
  /samsung\/vdx-installer/,
  /api\.github\.com/,
];

interface Hit {
  file: string;
  line: number;
  match: string;
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir);
  for (const name of entries) {
    const full = join(dir, name);
    const s = await stat(full);
    if (s.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === 'out') continue;
      yield* walk(full);
    } else if (s.isFile() && /\.(ts|tsx|js|jsx|mts|cts)$/.test(name)) {
      yield full;
    }
  }
}

async function main(): Promise<void> {
  let scanned = false;
  try {
    await stat(SCAN_DIR);
    scanned = true;
  } catch {
    // src/ missing — nothing to check.
  }
  if (!scanned) {
    console.log('check-no-hardcoded-source: src/ not found, skipping');
    return;
  }

  const hits: Hit[] = [];
  for await (const file of walk(SCAN_DIR)) {
    const rel = relative(ROOT, file).split(sep).join('/');
    if (rel === ALLOWED_FILE.split(sep).join('/')) continue;
    const text = await readFile(file, 'utf-8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      for (const pattern of FORBIDDEN_PATTERNS) {
        const m = line.match(pattern);
        if (m) hits.push({ file: rel, line: i + 1, match: m[0] });
      }
    }
  }

  if (hits.length === 0) {
    console.log('check-no-hardcoded-source: clean');
    return;
  }

  console.error('check-no-hardcoded-source: forbidden references found');
  console.error(`Allowed only in: ${ALLOWED_FILE.split(sep).join('/')}`);
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  ${h.match}`);
  }
  process.exitCode = 1;
}

await main();
