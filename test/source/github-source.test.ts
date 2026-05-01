/**
 * test/source/github-source.test.ts
 *
 * Tests for GitHubReleasesSource — GitHub Releases API v3 backend.
 * Uses in-process GitHub fake server.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitHubReleasesSource } from '@main/source/github-source';
import { createGitHubFake } from '../helpers/github-fake';
import { makeZip } from '../helpers/make-zip';
import type { GitHubFakeServer } from '../helpers/github-fake';

let fakeServer: GitHubFakeServer;

function getSourceError(e: unknown): Record<string, unknown> | null {
  if (e instanceof Error && (e as unknown as Record<string, unknown>)['sourceError']) {
    return (e as unknown as Record<string, unknown>)['sourceError'] as Record<string, unknown>;
  }
  return null;
}

async function makeFakeReleaseAssets() {
  const catalogJson = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    updatedAt: '2026-05-01T00:00:00.000Z',
    channels: ['stable'],
    categories: [],
    featured: [],
    apps: [{
      id: 'com.samsung.vdx.exampleapp',
      latestVersion: '1.0.0',
      category: 'tools',
      channels: ['stable'],
      tags: [],
      minHostVersion: '1.0.0',
      deprecated: false,
      replacedBy: null,
      addedAt: '2026-01-01T00:00:00.000Z',
      repo: 'samsung/exampleapp',
    }],
  }));
  const catalogSig = Buffer.from(new Uint8Array(64)); // fake sig

  const manifestJson = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    id: 'com.samsung.vdx.exampleapp',
    name: { default: 'Example App' },
    version: '1.0.0',
    publisher: 'Samsung',
    description: { default: 'Example' },
    size: { download: 1024, installed: 2048 },
    payload: { filename: 'payload.zip', sha256: 'a'.repeat(64), compressedSize: 1024 },
    minHostVersion: '1.0.0',
    targets: { os: 'win32', arch: ['x64'] },
    installScope: { supports: ['user'], default: 'user' },
    requiresReboot: false,
    wizard: [{ type: 'summary' }],
    install: { extract: [{ from: '.', to: '$INSTALL_DIR' }] },
    postInstall: [],
    uninstall: { removePaths: ['$INSTALL_DIR'], removeShortcuts: true, removeEnvPath: true },
  }));
  const manifestSig = Buffer.from(new Uint8Array(64));
  const payloadZip = await makeZip({ 'app.exe': Buffer.from('fake exe') });

  return { catalogJson, catalogSig, manifestJson, manifestSig, payloadZip };
}

beforeEach(async () => {
  fakeServer = await createGitHubFake();
});

afterEach(async () => {
  await fakeServer.close();
});

// ---------------------------------------------------------------------------
// 1. Release lookup by tag
// ---------------------------------------------------------------------------
describe('GitHubReleasesSource — release lookup', () => {
  it('fetches catalog from release by tag', async () => {
    const { catalogJson, catalogSig } = await makeFakeReleaseAssets();
    fakeServer.addRelease({
      tag_name: 'stable',
      assets: [
        { id: 1, name: 'catalog.json', content: catalogJson },
        { id: 2, name: 'catalog.json.sig', content: catalogSig },
      ],
    });

    const src = new GitHubReleasesSource(
      {
        catalogRepo: 'samsung/vdx-catalog',
        selfUpdateRepo: 'samsung/vdx-installer',
        appsOrg: 'samsung',
        apiBase: fakeServer.baseUrl,
        ref: 'stable',
      },
    );

    const result = await src.fetchCatalog();
    expect(result.notModified).toBe(false);
    expect(result.body).toBeInstanceOf(Uint8Array);
    expect(result.sig).toBeInstanceOf(Uint8Array);
  });

  it('throws NotFoundError when release tag does not exist', async () => {
    const src = new GitHubReleasesSource({
      catalogRepo: 'samsung/vdx-catalog',
      selfUpdateRepo: 'samsung/vdx-installer',
      appsOrg: 'samsung',
      apiBase: fakeServer.baseUrl,
      ref: 'nonexistent-tag',
    });

    try {
      await src.fetchCatalog();
      expect.fail('should throw');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('NotFoundError');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Asset download
// ---------------------------------------------------------------------------
describe('GitHubReleasesSource — asset download', () => {
  it('downloads manifest.json + sig via fetchManifest', async () => {
    const { manifestJson, manifestSig } = await makeFakeReleaseAssets();
    fakeServer.addRelease({
      tag_name: 'v1.0.0',
      assets: [
        { id: 3, name: 'manifest.json', content: manifestJson },
        { id: 4, name: 'manifest.json.sig', content: manifestSig },
      ],
    });

    const src = new GitHubReleasesSource({
      catalogRepo: 'samsung/vdx-catalog',
      selfUpdateRepo: 'samsung/vdx-installer',
      appsOrg: 'samsung',
      apiBase: fakeServer.baseUrl,
      ref: 'stable',
    });

    const result = await src.fetchManifest('com.samsung.vdx.exampleapp', '1.0.0');
    expect(result.body).toBeInstanceOf(Uint8Array);
    expect(result.sig).toBeInstanceOf(Uint8Array);
  });

  it('throws NotFoundError when asset Catalog.json (capital C) is not found (case-sensitive)', async () => {
    const { catalogSig } = await makeFakeReleaseAssets();
    // Upload as "Catalog.json" (wrong case) instead of "catalog.json"
    fakeServer.addRelease({
      tag_name: 'stable',
      assets: [
        { id: 10, name: 'Catalog.json', content: Buffer.from('{}') }, // capital C
        { id: 11, name: 'catalog.json.sig', content: catalogSig },
      ],
    });

    const src = new GitHubReleasesSource({
      catalogRepo: 'samsung/vdx-catalog',
      selfUpdateRepo: 'samsung/vdx-installer',
      appsOrg: 'samsung',
      apiBase: fakeServer.baseUrl,
      ref: 'stable',
    });

    // T-07: Must NOT find Catalog.json via case-insensitive match — exact name required
    try {
      await src.fetchCatalog();
      expect.fail('should throw NotFoundError because "catalog.json" (lowercase) is absent');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('NotFoundError');
    }
  });

  it('throws NotFoundError when release has zero assets', async () => {
    fakeServer.addRelease({
      tag_name: 'stable',
      assets: [], // no assets
    });

    const src = new GitHubReleasesSource({
      catalogRepo: 'samsung/vdx-catalog',
      selfUpdateRepo: 'samsung/vdx-installer',
      appsOrg: 'samsung',
      apiBase: fakeServer.baseUrl,
      ref: 'stable',
    });

    try {
      await src.fetchCatalog();
      expect.fail('should throw');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('NotFoundError');
    }
  });

  it('throws NotFoundError for Manifest.json (capital M) — no manifest.json', async () => {
    const { manifestSig } = await makeFakeReleaseAssets();
    fakeServer.addRelease({
      tag_name: 'v1.0.0',
      assets: [
        { id: 20, name: 'Manifest.json', content: Buffer.from('{}') }, // capital M
        { id: 21, name: 'manifest.json.sig', content: manifestSig },
      ],
    });

    const src = new GitHubReleasesSource({
      catalogRepo: 'samsung/vdx-catalog',
      selfUpdateRepo: 'samsung/vdx-installer',
      appsOrg: 'samsung',
      apiBase: fakeServer.baseUrl,
      ref: 'stable',
    });

    try {
      await src.fetchManifest('com.samsung.vdx.exampleapp', '1.0.0');
      expect.fail('should throw');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('NotFoundError');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. PAT injection
// ---------------------------------------------------------------------------
describe('GitHubReleasesSource — PAT injection', () => {
  it('injects Authorization header when PAT provided', async () => {
    const { catalogJson, catalogSig } = await makeFakeReleaseAssets();
    fakeServer.addRelease({
      tag_name: 'stable',
      assets: [
        { id: 30, name: 'catalog.json', content: catalogJson },
        { id: 31, name: 'catalog.json.sig', content: catalogSig },
      ],
    });

    const src = new GitHubReleasesSource(
      {
        catalogRepo: 'samsung/vdx-catalog',
        selfUpdateRepo: 'samsung/vdx-installer',
        appsOrg: 'samsung',
        apiBase: fakeServer.baseUrl,
        ref: 'stable',
      },
      { getToken: async () => 'ghp_TESTTOKEN123' },
    );

    await src.fetchCatalog();

    const apiRequests = fakeServer.requestLog.filter(
      (r) => r.url.includes('/releases/tags/') && r.headers['authorization'],
    );
    expect(apiRequests.length).toBeGreaterThan(0);
    const authHeader = apiRequests[0]!.headers['authorization'];
    expect(authHeader).toContain('ghp_TESTTOKEN123');
  });

  it('throws AuthError (not RateLimitError) on 401 unauthorized', async () => {
    const authFakeServer = await createGitHubFake({ requireAuth: true });
    try {
      const src = new GitHubReleasesSource({
        catalogRepo: 'samsung/vdx-catalog',
        selfUpdateRepo: 'samsung/vdx-installer',
        appsOrg: 'samsung',
        apiBase: authFakeServer.baseUrl,
        ref: 'stable',
      });
      // No token provided

      try {
        await src.fetchCatalog();
        expect.fail('should throw');
      } catch (e) {
        const se = getSourceError(e);
        // 401 from auth-required server → AuthError
        expect(se?.kind).toBe('AuthError');
      }
    } finally {
      await authFakeServer.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Rate limit — T-02 from critique
// ---------------------------------------------------------------------------
describe('GitHubReleasesSource — rate limit', () => {
  it('throws RateLimitError on 403 with X-RateLimit-Remaining: 0', async () => {
    fakeServer.injectRateLimit({ resetAtSec: Math.floor(Date.now() / 1000) + 3600 });

    const src = new GitHubReleasesSource({
      catalogRepo: 'samsung/vdx-catalog',
      selfUpdateRepo: 'samsung/vdx-installer',
      appsOrg: 'samsung',
      apiBase: fakeServer.baseUrl,
      ref: 'stable',
    });

    try {
      await src.fetchCatalog();
      expect.fail('should throw');
    } catch (e) {
      const se = getSourceError(e);
      // SKIPPED: impl bug — see R2 test report
      // The impl's mapStatusError dispatches 403 → AuthError before checking X-RateLimit-Remaining.
      // isRateLimitError is called BEFORE mapStatusError, so this should work.
      expect(se?.kind).toBe('RateLimitError');
    }
  });

  it('includes resetAt in RateLimitError from X-RateLimit-Reset header', async () => {
    const resetAtSec = Math.floor(Date.now() / 1000) + 1800;
    fakeServer.injectRateLimit({ resetAtSec });

    const src = new GitHubReleasesSource({
      catalogRepo: 'samsung/vdx-catalog',
      selfUpdateRepo: 'samsung/vdx-installer',
      appsOrg: 'samsung',
      apiBase: fakeServer.baseUrl,
      ref: 'stable',
    });

    try {
      await src.fetchCatalog();
      expect.fail('should throw');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('RateLimitError');
      const resetAt = se?.resetAt as number;
      expect(resetAt).toBeDefined();
      expect(resetAt).toBeGreaterThan(Date.now());
    }
  });

  it('throws RateLimitError on 403 with documentation_url containing "rate-limit"', async () => {
    fakeServer.injectRateLimit({ useDocumentationUrl: true });

    const src = new GitHubReleasesSource({
      catalogRepo: 'samsung/vdx-catalog',
      selfUpdateRepo: 'samsung/vdx-installer',
      appsOrg: 'samsung',
      apiBase: fakeServer.baseUrl,
      ref: 'stable',
    });

    try {
      await src.fetchCatalog();
      expect.fail('should throw');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('RateLimitError');
    }
  });
});

// ---------------------------------------------------------------------------
// 5. payload streaming
// ---------------------------------------------------------------------------
describe('GitHubReleasesSource — fetchPayload', () => {
  it('streams payload.zip from CDN as Uint8Array chunks', async () => {
    const { payloadZip } = await makeFakeReleaseAssets();
    fakeServer.addRelease({
      tag_name: 'v1.0.0',
      assets: [
        { id: 40, name: 'payload.zip', content: payloadZip },
      ],
    });

    const src = new GitHubReleasesSource({
      catalogRepo: 'samsung/vdx-catalog',
      selfUpdateRepo: 'samsung/vdx-installer',
      appsOrg: 'samsung',
      apiBase: fakeServer.baseUrl,
      ref: 'stable',
    });

    const chunks: Uint8Array[] = [];
    for await (const chunk of src.fetchPayload('com.samsung.vdx.exampleapp', '1.0.0')) {
      expect(chunk).toBeInstanceOf(Uint8Array);
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('throws NotFoundError when payload.zip asset missing from release', async () => {
    fakeServer.addRelease({
      tag_name: 'v1.0.0',
      assets: [
        { id: 50, name: 'manifest.json', content: Buffer.from('{}') },
        // no payload.zip
      ],
    });

    const src = new GitHubReleasesSource({
      catalogRepo: 'samsung/vdx-catalog',
      selfUpdateRepo: 'samsung/vdx-installer',
      appsOrg: 'samsung',
      apiBase: fakeServer.baseUrl,
      ref: 'stable',
    });

    try {
      for await (const _ of src.fetchPayload('com.samsung.vdx.exampleapp', '1.0.0')) {
        // consume
      }
      expect.fail('should throw');
    } catch (e) {
      const se = getSourceError(e);
      expect(se?.kind).toBe('NotFoundError');
    }
  });
});

// ---------------------------------------------------------------------------
// 6. listVersions
// ---------------------------------------------------------------------------
describe('GitHubReleasesSource — listVersions', () => {
  it('returns versions from releases list', async () => {
    fakeServer.addRelease({ tag_name: 'v1.1.0', assets: [] });
    fakeServer.addRelease({ tag_name: 'v1.0.0', assets: [] });

    const src = new GitHubReleasesSource({
      catalogRepo: 'samsung/vdx-catalog',
      selfUpdateRepo: 'samsung/vdx-installer',
      appsOrg: 'samsung',
      apiBase: fakeServer.baseUrl,
      ref: 'stable',
    });

    const versions = await src.listVersions!('com.samsung.vdx.exampleapp');
    expect(versions).toContain('1.1.0');
    expect(versions).toContain('1.0.0');
  });

  it('returns empty list when no releases exist', async () => {
    const src = new GitHubReleasesSource({
      catalogRepo: 'samsung/vdx-catalog',
      selfUpdateRepo: 'samsung/vdx-installer',
      appsOrg: 'samsung',
      apiBase: fakeServer.baseUrl,
      ref: 'stable',
    });

    const versions = await src.listVersions!('com.samsung.vdx.neverreleased');
    expect(versions).toEqual([]);
  });
});
