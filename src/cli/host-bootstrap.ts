/**
 * CLI host bootstrap — assembles the same engine context the Electron main
 * process uses, but without Electron.
 *
 * The CLI is one-shot: each command boots the host, runs, and exits. No
 * background polling, no tray, no headless server. Most of what the GUI
 * does is irrelevant for a `vdx install foo` invocation; what matters is
 * the shared `installed.json`, the catalog cache, and the engine itself.
 *
 * Phase 1.0 caveat: `createPackageSource` only supports `local-fs`. CLI
 * commands that need network catalog (apps via http-mirror or github)
 * will fail loud at bootstrap rather than half-work.
 */
import * as nodeFs from 'node:fs';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { resolveCliPaths, type CliPaths } from './paths';
import {
  createInstalledStore,
  createJournalStore,
  createTransactionRunner,
  type InstalledStore,
  type Platform,
  type TransactionRunner,
  type JournalStore,
} from '@main/engine';
import { selectPlatform } from '@main/platform/select';
import { loadVdxConfig, _resetLoadedForTest } from '@main/config/load-config';
import { createPackageSource } from '@main/source/factory';
import { resolveTrustRoots } from '@main/config/trust-roots';
import type { VdxConfig } from '@shared/config/vdx-config';
import type { PackageSource } from '@shared/source/package-source';
import * as ed from '@noble/ed25519';

const HOST_VERSION = '0.1.0-dev';

export interface CliHost {
  paths: CliPaths;
  config: VdxConfig;
  installedStore: InstalledStore;
  journalStore: JournalStore;
  runner: TransactionRunner;
  platform: Platform;
  packageSource: PackageSource | null;
  /** Trust-root union (full set: config.trustRoots + dev key when applicable). */
  trustRoots: Uint8Array[];
  hostVersion: string;
}

let cached: CliHost | null = null;

/**
 * Bootstrap the CLI host. Idempotent — repeated calls return the same
 * instance so subcommands sharing one process get one set of stores.
 *
 * Throws on config-load / trust-root failure so callers can surface the
 * error to the terminal cleanly via try/catch.
 */
export async function bootCliHost(): Promise<CliHost> {
  if (cached) return cached;

  const paths = resolveCliPaths();
  for (const dir of [
    paths.userData,
    paths.cacheDir,
    paths.logsDir,
    paths.locksDir,
    paths.journalDir,
    paths.keysDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  // Reset the loadVdxConfig singleton — the GUI process and the CLI process
  // are distinct processes in normal use, but tests run them in the same
  // Vitest worker.
  _resetLoadedForTest();
  const cwd = process.cwd();
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
  const exeDir = cwd; // No "next-to-exe" in CLI; the user's CWD is the closest analog.
  const appDataDir = path.dirname(paths.userData);
  const configResult = await loadVdxConfig({ exeDir, appDataDir });
  if (!configResult.ok) {
    throw new Error(`Config load failed: ${configResult.error.message}`);
  }
  const config = configResult.value;
  void home; // intentionally unused — homedir was an early ergonomics idea, kept for future fallbacks

  const installedStore = createInstalledStore(paths.installedJson, nodeFs, HOST_VERSION);
  const journalStore = createJournalStore(paths.journalDir, nodeFs);
  const runner = createTransactionRunner({ journal: journalStore });
  // Real platform impl when running on the actual OS — `vdx install` on
  // Linux should install into ~/.config the same way the GUI does. In
  // test environments the caller passes their own platform via the
  // testing-only `setCliHost` helper.
  const platform = selectPlatform();

  // Dev keypair for local-fs / unsigned dev catalogs. Same lazy/eager rules
  // as the host. We always create it on first run so the CLI can sign its
  // own state-export sigs (future feature).
  const devPub = ensureDevPubKey(paths.keysDir);
  const trustRoots = resolveTrustRoots(config, { devPubKey: devPub });
  if (trustRoots.length === 0) {
    throw new Error(
      'No trust roots available — set vdx.config.json#trustRoots or enable developerMode',
    );
  }

  let packageSource: PackageSource | null = null;
  try {
    packageSource = await createPackageSource(config.source);
  } catch (e) {
    // Network sources aren't available in Phase 1.0 — mark the source as
    // null and let individual commands surface "this command needs a
    // network source" errors with better wording than a stack trace.
    packageSource = null;
    void e;
  }

  cached = {
    paths,
    config,
    installedStore,
    journalStore,
    runner,
    platform,
    packageSource,
    trustRoots,
    hostVersion: HOST_VERSION,
  };
  return cached;
}

/** TEST HOOK — reset the cached host and the underlying config singleton. */
export function _resetCliHostForTest(): void {
  cached = null;
  _resetLoadedForTest();
}

/** TEST HOOK — inject a pre-built host (e.g. with MockPlatform + memfs). */
export function _setCliHostForTest(h: CliHost): void {
  cached = h;
}

function ensureDevPubKey(keysDir: string): Uint8Array {
  // Synchronous variant of `ensureDevKeyPair` — the noble API offers a
  // sync `getPublicKey`. Same paths so a `vdx-installer` CLI run after
  // a GUI launch reuses the keypair.
  const pubPath = path.join(keysDir, 'dev-pub.bin');
  const privPath = path.join(keysDir, 'dev-priv.bin');
  if (existsSync(pubPath) && existsSync(privPath)) {
    return new Uint8Array(readFileSync(pubPath));
  }
  const priv = ed.utils.randomPrivateKey();
  const pub = ed.getPublicKey(priv);
  writeFileSync(privPath, Buffer.from(priv), { mode: 0o600 });
  writeFileSync(pubPath, Buffer.from(pub), { mode: 0o644 });
  return new Uint8Array(pub);
}
