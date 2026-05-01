/**
 * test/source/factory.test.ts
 *
 * Tests for the createPackageSource factory.
 */
import { describe, it, expect } from 'vitest';
import { createPackageSource } from '@main/source/factory';
import type { VdxConfig } from '@shared/config/vdx-config';

type SourceConfig = VdxConfig['source'];

describe('createPackageSource — factory', () => {
  it('creates LocalFsSource from local-fs config', async () => {
    const config: SourceConfig = {
      type: 'local-fs',
      localFs: { rootPath: '/tmp/test-root' },
    };
    // Phase 1.0 gate allows local-fs
    const src = await createPackageSource(config);
    expect(src.id).toBe('local-fs');
    expect(src.displayName).toContain('/tmp/test-root');
  });

  it('throws Error (not SourceError) when local-fs config is missing localFs field', async () => {
    // Bypass TypeScript by casting — simulates a misconfigured object at runtime
    const config = { type: 'local-fs' } as SourceConfig;
    await expect(createPackageSource(config)).rejects.toThrow(Error);
    await expect(createPackageSource(config)).rejects.toThrow(/missing/i);
  });

  it('throws Error for github type in Phase 1.0 (PHASE_1_LOCAL_FS_ONLY)', async () => {
    const config: SourceConfig = {
      type: 'github',
      github: {
        catalogRepo: 'org/catalog',
        selfUpdateRepo: 'org/installer',
        appsOrg: 'org',
        apiBase: 'https://api.github.com',
        ref: 'stable',
      },
    };
    await expect(createPackageSource(config)).rejects.toThrow(/Phase 1\.0/);
  });

  it('throws Error for http-mirror type in Phase 1.0 (PHASE_1_LOCAL_FS_ONLY)', async () => {
    const config: SourceConfig = {
      type: 'http-mirror',
      httpMirror: { baseUrl: 'https://mirror.example.com' },
    };
    await expect(createPackageSource(config)).rejects.toThrow(/Phase 1\.0/);
  });

  it('factory does not eagerly reach the network (local-fs only instantiates disk source)', async () => {
    // This is verified implicitly: we pass a non-existent rootPath and the source
    // is created without making any network request (no immediate access check).
    const config: SourceConfig = {
      type: 'local-fs',
      localFs: { rootPath: '/nonexistent/path' },
    };
    // No throw at construction — network check is deferred to first call
    const src = await createPackageSource(config);
    expect(src).toBeDefined();
  });

  it('accepts injected fs dependency for LocalFsSource', async () => {
    const { fs: memFs } = await import('memfs');
    const config: SourceConfig = {
      type: 'local-fs',
      localFs: { rootPath: '/mem-root' },
    };
    const src = await createPackageSource(config, { fs: memFs.promises as Parameters<typeof createPackageSource>[1] extends { fs?: infer F } ? F : never });
    expect(src.id).toBe('local-fs');
  });
});
