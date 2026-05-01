/**
 * Factory for PackageSource — switches on config.source.type.
 *
 * Phase 1.0 note: PHASE_1_LOCAL_FS_ONLY flag enforces that only LocalFsSource
 * can be instantiated in Phase 1.0. Remove in Phase 2.
 *
 * @see docs/superpowers/specs/2026-05-01-package-source-abstraction.md §6.3, §8.1
 */
import type { VdxConfig } from '@shared/config/vdx-config';
import type { PackageSource } from '@shared/source/package-source';
import type * as nodeFsPromises from 'node:fs/promises';

export interface FactoryDeps {
  /** Injected fs for LocalFsSource (e.g. memfs in tests). Default: node:fs/promises. */
  fs?: typeof nodeFsPromises;
  /** Token provider for GitHubReleasesSource. Keytar wiring is R3's job. */
  getToken?: () => Promise<string | undefined>;
}

/**
 * Phase 1.0 gate: only local-fs is permitted. Flip to false in Phase 2.
 * When true, any config.source.type !== 'local-fs' causes a thrown Error
 * (not SourceError — this is a config/build error).
 */
const PHASE_1_LOCAL_FS_ONLY = true;

/**
 * Instantiate the PackageSource described by the loaded config.
 *
 * Throws `Error` (not SourceError) on invalid or unsupported config combos.
 */
export async function createPackageSource(
  config: VdxConfig['source'],
  deps?: FactoryDeps,
): Promise<PackageSource> {
  if (PHASE_1_LOCAL_FS_ONLY) {
    if (config.type !== 'local-fs') {
      throw new Error(
        `Phase 1.0 supports only source.type === 'local-fs'; got '${config.type}'. ` +
          `Set source.type to 'local-fs' in vdx.config.json or wait for Phase 2.`,
      );
    }

    if (!config.localFs) {
      throw new Error(`source.type is 'local-fs' but source.localFs is missing`);
    }

    const { LocalFsSource } = await import('./local-fs-source');
    return new LocalFsSource({
      rootPath: config.localFs.rootPath,
      fs: deps?.fs,
    });
  }

  // Phase 2+ full dispatch
  switch (config.type) {
    case 'github': {
      if (!config.github) {
        throw new Error(`source.type is 'github' but source.github is missing`);
      }
      const { GitHubReleasesSource } = await import('./github-source');
      return new GitHubReleasesSource(config.github, { getToken: deps?.getToken });
    }

    case 'http-mirror': {
      if (!config.httpMirror) {
        throw new Error(`source.type is 'http-mirror' but source.httpMirror is missing`);
      }
      const { HttpMirrorSource } = await import('./http-mirror-source');
      return new HttpMirrorSource(config.httpMirror);
    }

    case 'local-fs': {
      if (!config.localFs) {
        throw new Error(`source.type is 'local-fs' but source.localFs is missing`);
      }
      const { LocalFsSource } = await import('./local-fs-source');
      return new LocalFsSource({
        rootPath: config.localFs.rootPath,
        fs: deps?.fs,
      });
    }

    default: {
      // TypeScript exhaustive check — should never reach here
      const exhaustive: never = config;
      throw new Error(`Unknown source type: ${String((exhaustive as { type: unknown }).type)}`);
    }
  }
}
