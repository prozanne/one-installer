/**
 * test/helpers/index.ts
 *
 * Central re-export for all test helpers. Import from this file in tests
 * so you don't have to remember individual helper module paths.
 */

export { getDevKeys, loadDevKeys } from './key-fixtures';
export { makeZip } from './make-zip';
export {
  makeVdxpkg,
  makeVdxpkgFromDir,
  makeVdxpkgFromManifest,
  makeUnsignedVdxpkg,
  makeBadlySignedVdxpkg,
} from './make-vdxpkg';
export type { MakeVdxpkgInput, MakeVdxpkgFromDirOpts, MakeVdxpkgFromManifestOpts } from './make-vdxpkg';
export { createMemPlatform, MockPlatform } from './mem-platform';
export type { CreateMemPlatformOpts, MockPlatformOptions } from './mem-platform';
export { buildSourceTree } from './build-source-tree';
export type { FsLike as BuildFsLike } from './build-source-tree';
export { createHttpFake } from './http-fake';
export type { HttpFakeServer, FaultSpec, RequestLogEntry } from './http-fake';
export { createGitHubFake } from './github-fake';
export type { GitHubFakeServer, FakeAsset, FakeRelease, RateLimitSpec } from './github-fake';
