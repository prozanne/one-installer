/**
 * build-source-tree.ts
 *
 * Lays out a complete on-disk source tree fixture used by LocalFsSource,
 * HTTP fake, and catalog tests.
 *
 * Returns `{ trustRoots }` so callers can pass to fetchCatalogVerified.
 */
import * as path from 'node:path';
import * as ed from '@noble/ed25519';
import { makeZip } from './make-zip';
import { getDevKeys } from './key-fixtures';

/** Minimal fs-like interface for writing the tree (real or memfs). */
export interface FsLike {
  mkdir(p: string, opts: { recursive: boolean }): Promise<unknown>;
  writeFile(p: string, data: Buffer | Uint8Array): Promise<void>;
}

/** Minimal catalog JSON matching CatalogSchema. */
const CATALOG_JSON = JSON.stringify({
  schemaVersion: 1,
  updatedAt: '2026-05-01T00:00:00.000Z',
  channels: ['stable'],
  categories: [{ id: 'tools', label: { default: 'Tools' } }],
  featured: [],
  apps: [
    {
      id: 'com.samsung.vdx.exampleapp',
      displayName: { default: 'Example App' },
      displayDescription: { default: 'An example app' },
      latestVersion: '1.1.0',
      category: 'tools',
      channels: ['stable'],
      tags: [],
      minHostVersion: '1.0.0',
      deprecated: false,
      replacedBy: null,
      addedAt: '2026-01-01T00:00:00.000Z',
      repo: 'samsung/exampleapp',
    },
    {
      id: 'com.samsung.vdx.anotherapp',
      displayName: { default: 'Another App' },
      displayDescription: { default: 'Another app' },
      latestVersion: '2.0.0',
      category: 'tools',
      channels: ['stable'],
      tags: [],
      minHostVersion: '1.0.0',
      deprecated: false,
      replacedBy: null,
      addedAt: '2026-01-01T00:00:00.000Z',
      repo: 'samsung/anotherapp',
    },
  ],
});

function makeManifestJson(appId: string, version: string, payloadSha256: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    id: appId,
    name: { default: 'Example App' },
    version,
    publisher: 'Samsung',
    description: { default: 'An example application' },
    size: { download: 1024, installed: 2048 },
    payload: {
      filename: 'payload.zip',
      sha256: payloadSha256,
      compressedSize: 1024,
    },
    minHostVersion: '1.0.0',
    targets: { os: 'win32', arch: ['x64'] },
    installScope: { supports: ['user'], default: 'user' },
    requiresReboot: false,
    wizard: [{ type: 'summary' }],
    install: { extract: [{ from: '.', to: '$INSTALL_DIR' }] },
    postInstall: [],
    uninstall: { removePaths: ['$INSTALL_DIR'], removeShortcuts: true, removeEnvPath: true },
  });
}

async function sign(data: Uint8Array, privKey: Uint8Array): Promise<Uint8Array> {
  return ed.signAsync(data, privKey);
}

/**
 * Build a full source tree at `rootDir` using the provided `fs` implementation.
 * Works with both real `node:fs/promises` and `memfs`.
 *
 * @returns `{ trustRoots }` — array of public key bytes for verifying the catalog.
 */
export async function buildSourceTree(
  rootDir: string,
  fs: FsLike,
): Promise<{ trustRoots: Uint8Array[] }> {
  const { priv: privKey, pub: pubKey } = await getDevKeys();

  // Helper to write a file and its signature
  async function writeWithSig(filePath: string, content: Buffer | Uint8Array): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content instanceof Buffer ? content : Buffer.from(content));
    const sig = await sign(content instanceof Uint8Array ? content : new Uint8Array(content), privKey);
    await fs.writeFile(filePath + '.sig', Buffer.from(sig));
  }

  // --- catalog.json ---
  const catalogBytes = Buffer.from(CATALOG_JSON, 'utf-8');
  await writeWithSig(path.join(rootDir, 'catalog.json'), catalogBytes);

  // --- com.samsung.vdx.exampleapp 1.0.0 ---
  const payload100 = await makeZip({
    'app.exe': Buffer.from('fake-exe-v1.0.0'),
    'readme.txt': Buffer.from('Example App 1.0.0'),
  });
  const sha256_100 = computeSha256(payload100);

  const manifest100 = Buffer.from(makeManifestJson('com.samsung.vdx.exampleapp', '1.0.0', sha256_100));
  await writeWithSig(
    path.join(rootDir, 'apps', 'com.samsung.vdx.exampleapp', '1.0.0', 'manifest.json'),
    manifest100,
  );
  await fs.mkdir(path.join(rootDir, 'apps', 'com.samsung.vdx.exampleapp', '1.0.0'), { recursive: true });
  await fs.writeFile(path.join(rootDir, 'apps', 'com.samsung.vdx.exampleapp', '1.0.0', 'payload.zip'), payload100);

  // icon.png for 1.0.0
  await fs.mkdir(path.join(rootDir, 'apps', 'com.samsung.vdx.exampleapp', '1.0.0', 'assets'), { recursive: true });
  await fs.writeFile(path.join(rootDir, 'apps', 'com.samsung.vdx.exampleapp', '1.0.0', 'assets', 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.mkdir(path.join(rootDir, 'apps', 'com.samsung.vdx.exampleapp', '1.0.0', 'assets', 'screenshots'), { recursive: true });
  await fs.writeFile(path.join(rootDir, 'apps', 'com.samsung.vdx.exampleapp', '1.0.0', 'assets', 'screenshots', '01.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  // --- com.samsung.vdx.exampleapp 1.1.0 ---
  const payload110 = await makeZip({
    'app.exe': Buffer.from('fake-exe-v1.1.0'),
    'readme.txt': Buffer.from('Example App 1.1.0'),
  });
  const sha256_110 = computeSha256(payload110);
  const manifest110 = Buffer.from(makeManifestJson('com.samsung.vdx.exampleapp', '1.1.0', sha256_110));
  await writeWithSig(
    path.join(rootDir, 'apps', 'com.samsung.vdx.exampleapp', '1.1.0', 'manifest.json'),
    manifest110,
  );
  await fs.mkdir(path.join(rootDir, 'apps', 'com.samsung.vdx.exampleapp', '1.1.0'), { recursive: true });
  await fs.writeFile(path.join(rootDir, 'apps', 'com.samsung.vdx.exampleapp', '1.1.0', 'payload.zip'), payload110);
  await fs.mkdir(path.join(rootDir, 'apps', 'com.samsung.vdx.exampleapp', '1.1.0', 'assets'), { recursive: true });
  await fs.writeFile(path.join(rootDir, 'apps', 'com.samsung.vdx.exampleapp', '1.1.0', 'assets', 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  // --- com.samsung.vdx.anotherapp 2.0.0 ---
  const payload200 = await makeZip({
    'main.exe': Buffer.from('another-app-v2.0.0'),
  });
  const sha256_200 = computeSha256(payload200);
  const manifest200 = Buffer.from(makeManifestJson('com.samsung.vdx.anotherapp', '2.0.0', sha256_200));
  await writeWithSig(
    path.join(rootDir, 'apps', 'com.samsung.vdx.anotherapp', '2.0.0', 'manifest.json'),
    manifest200,
  );
  await fs.mkdir(path.join(rootDir, 'apps', 'com.samsung.vdx.anotherapp', '2.0.0'), { recursive: true });
  await fs.writeFile(path.join(rootDir, 'apps', 'com.samsung.vdx.anotherapp', '2.0.0', 'payload.zip'), payload200);
  await fs.mkdir(path.join(rootDir, 'apps', 'com.samsung.vdx.anotherapp', '2.0.0', 'assets'), { recursive: true });
  await fs.writeFile(path.join(rootDir, 'apps', 'com.samsung.vdx.anotherapp', '2.0.0', 'assets', 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  return { trustRoots: [pubKey] };
}

/** Compute SHA-256 hex of a buffer (synchronous, using node:crypto). */
function computeSha256(buf: Buffer): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(buf).digest('hex');
}
