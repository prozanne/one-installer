#!/usr/bin/env node
/**
 * vdx-pack — minimal CLI for app/agent teams.
 *
 * Subcommands:
 *   vdx-pack validate <manifest.json>          → schema + semantic checks
 *   vdx-pack hash <file>                       → sha256 (paste into allowedHashes)
 *   vdx-pack build --manifest <m.json> --payload <dir> --out <out.vdxpkg>
 *                                              → produce a signed .vdxpkg
 *   vdx-pack sign --key <priv.bin> <file>      → produce <file>.sig
 *
 * The CLI is intentionally tiny; --json outputs structured results so AI
 * agents (Cursor / Cline) can pipe them through their tool-call loops.
 */
import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import * as ed from '@noble/ed25519';

import { ManifestSchema, type Manifest } from '../shared/schema/manifest';
import { validateManifestSemantics } from '../main/engine/validate';
import yazl from 'yazl';

interface CliResult {
  ok: boolean;
  error?: string;
  data?: unknown;
}

function jsonOut(r: CliResult): never {
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exit(r.ok ? 0 : 1);
}

function fail(msg: string, json: boolean): never {
  if (json) jsonOut({ ok: false, error: msg });
  process.stderr.write(`vdx-pack: ${msg}\n`);
  process.exit(1);
}

function parseFlags(argv: string[]): {
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// ---------------------------------------------------------------------------
// validate <manifest.json>
// ---------------------------------------------------------------------------
async function cmdValidate(argv: string[]): Promise<void> {
  const { positional, flags } = parseFlags(argv);
  const json = flags['json'] === true;
  const path = positional[0];
  if (!path) fail('usage: vdx-pack validate <manifest.json> [--payload <dir>] [--json]', json);

  let manifest: Manifest;
  try {
    const raw = JSON.parse(readFileSync(resolve(path), 'utf-8')) as unknown;
    manifest = ManifestSchema.parse(raw);
  } catch (e) {
    return fail(`schema invalid: ${(e as Error).message}`, json);
  }

  // Semantic validation needs the payload entry list — accept --payload <dir>
  // and walk it; absent it, we still run schema-only validation.
  let payloadEntries: string[] = [];
  const payloadDir = flags['payload'];
  if (typeof payloadDir === 'string') {
    const root = resolve(payloadDir);
    payloadEntries = walk(root, root);
  }

  const semantic = validateManifestSemantics(manifest, { payloadEntries });
  if (!semantic.ok) {
    if (json) jsonOut({ ok: false, error: 'semantic validation failed', data: semantic.error });
    for (const err of semantic.error) process.stderr.write(`  • ${err}\n`);
    process.exit(2);
  }

  if (json) jsonOut({ ok: true, data: { id: manifest.id, version: manifest.version } });
  process.stdout.write(`✓ ${manifest.id} v${manifest.version} valid\n`);
}

function walk(root: string, current: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = resolve(current, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(root, full));
    } else if (entry.isFile()) {
      out.push(relative(root, full).replace(/\\/g, '/'));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// hash <file>
// ---------------------------------------------------------------------------
async function cmdHash(argv: string[]): Promise<void> {
  const { positional, flags } = parseFlags(argv);
  const json = flags['json'] === true;
  const path = positional[0];
  if (!path) fail('usage: vdx-pack hash <file> [--json]', json);
  const data = readFileSync(resolve(path));
  const sha = createHash('sha256').update(data).digest('hex');
  if (json) jsonOut({ ok: true, data: { sha256: sha, file: path } });
  process.stdout.write(`sha256:${sha}\n`);
}

// ---------------------------------------------------------------------------
// build --manifest <m.json> --payload <dir> --out <out.vdxpkg> [--key <priv>]
// ---------------------------------------------------------------------------
async function cmdBuild(argv: string[]): Promise<void> {
  const { flags } = parseFlags(argv);
  const json = flags['json'] === true;
  const manifestPath = flags['manifest'];
  const payloadDir = flags['payload'];
  const outPath = flags['out'];
  const keyPath = flags['key'];
  if (typeof manifestPath !== 'string' || typeof payloadDir !== 'string' || typeof outPath !== 'string') {
    fail('usage: vdx-pack build --manifest <m.json> --payload <dir> --out <out.vdxpkg> [--key <priv.bin>] [--json]', json);
  }

  const manifest = ManifestSchema.parse(
    JSON.parse(readFileSync(resolve(manifestPath as string), 'utf-8')) as unknown,
  );

  // Build payload.zip first so we can compute the sha256 + size for the
  // manifest. Streams in alphabetical-by-path order for reproducibility.
  const payloadRoot = resolve(payloadDir as string);
  const entries = walk(payloadRoot, payloadRoot).sort();
  if (entries.length === 0) fail(`payload dir is empty: ${payloadRoot}`, json);

  const payloadBytes = await zipFiles(payloadRoot, entries);
  const payloadSha = createHash('sha256').update(payloadBytes).digest('hex');

  const finalManifest: Manifest = {
    ...manifest,
    payload: {
      filename: 'payload.zip',
      sha256: payloadSha,
      compressedSize: payloadBytes.length,
    },
  };
  const manifestJson = Buffer.from(JSON.stringify(finalManifest));

  // Sign — if no key is supplied, write a dummy zero-sig so dev mode still
  // accepts the package. The CLI emits a clear stderr warning so the operator
  // knows production releases must be signed properly.
  let sigBytes: Buffer;
  if (typeof keyPath === 'string') {
    const priv = new Uint8Array(readFileSync(resolve(keyPath)));
    sigBytes = Buffer.from(await ed.signAsync(manifestJson, priv));
  } else {
    process.stderr.write(
      'vdx-pack: WARNING — no --key supplied; .vdxpkg will be unsigned (dev mode only).\n',
    );
    sigBytes = Buffer.alloc(64); // structurally present, cryptographically invalid
  }

  const vdxpkg = await zipBuffers([
    { name: 'manifest.json', data: manifestJson },
    { name: 'manifest.json.sig', data: sigBytes },
    { name: 'payload.zip', data: payloadBytes },
  ]);
  writeFileSync(resolve(outPath as string), vdxpkg);

  const result = {
    ok: true,
    data: {
      out: outPath,
      id: finalManifest.id,
      version: finalManifest.version,
      payloadSha256: payloadSha,
      payloadSize: payloadBytes.length,
      vdxpkgSize: vdxpkg.length,
      signed: typeof keyPath === 'string',
    },
  };
  if (json) jsonOut(result);
  process.stdout.write(
    `✓ built ${outPath} (${(vdxpkg.length / 1024).toFixed(1)} KiB)\n`,
  );
  process.stdout.write(`  payload sha256: ${payloadSha}\n`);
  if (typeof keyPath !== 'string') {
    process.stdout.write('  signed: NO  (use --key for prod releases)\n');
  }
}

function zipFiles(root: string, entries: string[]): Promise<Buffer> {
  return new Promise((resolveP, reject) => {
    const z = new yazl.ZipFile();
    for (const rel of entries) {
      const full = isAbsolute(rel) ? rel : resolve(root, rel);
      const st = statSync(full);
      if (!st.isFile()) continue;
      z.addFile(full, rel);
    }
    z.end();
    const chunks: Buffer[] = [];
    z.outputStream.on('data', (c) => chunks.push(c as Buffer));
    z.outputStream.on('end', () => resolveP(Buffer.concat(chunks)));
    z.outputStream.on('error', reject);
  });
}

function zipBuffers(items: { name: string; data: Buffer }[]): Promise<Buffer> {
  return new Promise((resolveP, reject) => {
    const z = new yazl.ZipFile();
    for (const item of items) z.addBuffer(item.data, item.name);
    z.end();
    const chunks: Buffer[] = [];
    z.outputStream.on('data', (c) => chunks.push(c as Buffer));
    z.outputStream.on('end', () => resolveP(Buffer.concat(chunks)));
    z.outputStream.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// sign --key <priv.bin> <file>
// ---------------------------------------------------------------------------
async function cmdSign(argv: string[]): Promise<void> {
  const { positional, flags } = parseFlags(argv);
  const json = flags['json'] === true;
  const keyPath = flags['key'];
  const file = positional[0];
  if (typeof keyPath !== 'string' || !file) {
    fail('usage: vdx-pack sign --key <priv.bin> <file> [--json]', json);
  }
  const priv = new Uint8Array(readFileSync(resolve(keyPath as string)));
  const data = readFileSync(resolve(file));
  const sig = await ed.signAsync(data, priv);
  const outPath = `${resolve(file)}.sig`;
  writeFileSync(outPath, Buffer.from(sig));
  if (json) jsonOut({ ok: true, data: { sig: outPath } });
  process.stdout.write(`✓ signed → ${outPath}\n`);
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------
async function main() {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case 'validate':
      await cmdValidate(rest);
      break;
    case 'hash':
      await cmdHash(rest);
      break;
    case 'build':
      await cmdBuild(rest);
      break;
    case 'sign':
      await cmdSign(rest);
      break;
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(
        [
          'vdx-pack — package and validate VDX apps/agents.',
          '',
          'Commands:',
          '  validate <manifest.json> [--payload <dir>]  schema + semantic checks',
          '  hash <file>                                 sha256 of a file (for allowedHashes)',
          '  build --manifest <m.json> --payload <dir>',
          '        --out <out.vdxpkg> [--key <priv.bin>] produce a (signed) .vdxpkg',
          '  sign --key <priv.bin> <file>                Ed25519 sign a file → <file>.sig',
          '',
          'All commands accept --json for AI-friendly structured output.',
          '',
        ].join('\n'),
      );
      break;
    default:
      process.stderr.write(`vdx-pack: unknown command '${cmd}'\n`);
      process.exit(2);
  }
}

main().catch((e) => {
  process.stderr.write(`vdx-pack: ${(e as Error).message}\n`);
  process.exit(1);
});
