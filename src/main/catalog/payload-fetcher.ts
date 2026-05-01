/**
 * fetchPayloadStream — wraps source.fetchPayload, hashing as bytes arrive.
 *
 * Throws on completion if final SHA-256 hash != expectedSha256.
 *
 * @see docs/superpowers/specs/2026-05-01-package-source-abstraction.md §5.2, §4.6 T4
 */
import { createHash } from 'node:crypto';
import type { PackageSource, ByteRange } from '@shared/source/package-source';

export interface FetchPayloadStreamOpts {
  expectedSha256: string;
  range?: ByteRange;
  signal?: AbortSignal;
}

/**
 * Stream payload bytes from the source, computing SHA-256 across all chunks.
 *
 * Yields `Uint8Array` chunks as they arrive from the source.
 * After the final chunk, verifies the accumulated hash against `expectedSha256`.
 *
 * Note on range + hashing (T4): when a range is requested, the hash is computed
 * over the slice only. Full-file integrity requires the caller to either:
 *   a) Always fetch the full file (no range), or
 *   b) Accumulate and re-hash the full file from all slices.
 *
 * The engine's payload-downloader handles (b) by hashing the concatenation of
 * all resume slices. This wrapper is a building block; it verifies the hash of
 * whatever bytes it yields.
 */
export async function* fetchPayloadStream(
  source: PackageSource,
  appId: string,
  version: string,
  opts: FetchPayloadStreamOpts,
): AsyncIterable<Uint8Array> {
  const hasher = createHash('sha256');

  const iterable = source.fetchPayload(appId, version, {
    range: opts.range,
    signal: opts.signal,
  });

  for await (const chunk of iterable) {
    hasher.update(chunk);
    yield chunk;
  }

  const actualHash = hasher.digest('hex');

  // Normalize expected hash: strip "sha256:" prefix if present
  const expected = opts.expectedSha256.startsWith('sha256:')
    ? opts.expectedSha256.slice('sha256:'.length)
    : opts.expectedSha256;

  if (actualHash !== expected) {
    throw new Error(
      `Payload hash mismatch for ${appId}@${version}: ` +
        `expected ${expected}, got ${actualHash}`,
    );
  }
}
