import { describe, it, expect } from 'vitest';
import { parseVdxpkg } from '@main/packages/vdxpkg';
import { makeVdxpkg } from '../helpers/make-vdxpkg';
import { getDevKeys } from '../helpers/key-fixtures';
import type { Manifest } from '@shared/schema';

const baseManifest = (): Omit<Manifest, 'payload'> => ({
  schemaVersion: 1,
  id: 'com.samsung.vdx.test',
  name: { default: 'Test' },
  version: '1.0.0',
  publisher: 'Samsung',
  description: { default: 'd' },
  size: { download: 1, installed: 2 },
  minHostVersion: '1.0.0',
  targets: { os: 'win32', arch: ['x64'] },
  installScope: { supports: ['user'], default: 'user' },
  requiresReboot: false,
  wizard: [{ type: 'summary' }],
  install: { extract: [{ from: '**/*', to: '{{installPath}}' }] },
  postInstall: [],
  uninstall: { removePaths: [], removeShortcuts: true, removeEnvPath: true },
});

describe('parseVdxpkg', () => {
  it('parses and verifies a valid bundle', async () => {
    const { vdxpkgBytes } = await makeVdxpkg({
      manifest: baseManifest(),
      payloadFiles: { 'a.txt': 'hi' },
    });
    const { pub } = await getDevKeys();
    const r = await parseVdxpkg(vdxpkgBytes, pub);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.manifest.id).toBe('com.samsung.vdx.test');
      expect(r.value.payloadBytes.length).toBeGreaterThan(0);
      expect(r.value.signatureValid).toBe(true);
    }
  });

  it('rejects when payload sha256 does not match manifest', async () => {
    const { vdxpkgBytes } = await makeVdxpkg({
      manifest: baseManifest(),
      payloadFiles: { 'a.txt': 'hi' },
      payloadOverride: {
        filename: 'payload.zip',
        sha256: 'a'.repeat(64),
        compressedSize: 1,
      },
    });
    const { pub } = await getDevKeys();
    const r = await parseVdxpkg(vdxpkgBytes, pub);
    expect(r.ok).toBe(false);
  });

  it('returns err (not throw) on a buffer with PK magic but corrupt central directory', async () => {
    // Realistic adversary: writer crashed mid-write, or transit truncation.
    // Buffer starts with PK\x03\x04 (local file header magic) but the central
    // directory is missing/garbled. yauzl may throw any of several errors.
    const corrupt = Buffer.alloc(128);
    corrupt[0] = 0x50; // 'P'
    corrupt[1] = 0x4b; // 'K'
    corrupt[2] = 0x03;
    corrupt[3] = 0x04;
    // Remaining bytes left as zeros — invalid local header + missing EOCD.
    const { pub } = await getDevKeys();
    const r = await parseVdxpkg(corrupt, pub);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/extract|zip/i);
  });

  it('returns err on completely empty buffer', async () => {
    const { pub } = await getDevKeys();
    const r = await parseVdxpkg(Buffer.alloc(0), pub);
    expect(r.ok).toBe(false);
  });

  it('reports signatureValid: false when wrong public key is provided', async () => {
    const { vdxpkgBytes } = await makeVdxpkg({
      manifest: baseManifest(),
      payloadFiles: { 'a.txt': 'hi' },
    });
    // Use a wrong-but-correctly-shaped public key.
    const wrongPub = new Uint8Array(32);
    wrongPub[0] = 1; // any non-default 32-byte buffer works as "wrong key"
    const r = await parseVdxpkg(vdxpkgBytes, wrongPub);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.signatureValid).toBe(false);
  });
});
