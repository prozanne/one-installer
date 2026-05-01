/**
 * fetchManifestVerified — fetch, verify, and parse a manifest via a PackageSource.
 *
 * @see docs/superpowers/specs/2026-05-01-package-source-abstraction.md §5.2
 */
import type { PackageSource } from '@shared/source/package-source';
import { ManifestSchema } from '@shared/schema/manifest';
import type { Manifest } from '@shared/schema/manifest';
import { verifyDetached } from '@main/packages/signature';

export interface FetchManifestVerifiedOpts {
  trustRoots: Uint8Array[];
  signal?: AbortSignal;
}

/**
 * Fetch and verify a manifest.
 *
 * - Calls `source.fetchManifest`.
 * - Verifies Ed25519 signature against trust roots.
 * - zod-parses the manifest JSON.
 * - Surfaces SourceError unchanged (re-throws).
 * - Throws plain Error for sig or zod failures.
 */
export async function fetchManifestVerified(
  source: PackageSource,
  appId: string,
  version: string,
  opts: FetchManifestVerifiedOpts,
): Promise<Manifest> {
  const result = await source.fetchManifest(appId, version, { signal: opts.signal });

  const { body, sig } = result;

  // Verify signature against trust roots (any match wins — T1 union semantics)
  let sigValid = false;
  for (const pubkey of opts.trustRoots) {
    const valid = await verifyDetached(body, sig, pubkey);
    if (valid) {
      sigValid = true;
      break;
    }
  }

  if (!sigValid) {
    throw new Error(
      `Manifest signature verification failed for ${appId}@${version}: ` +
        `signature does not match any trust root`,
    );
  }

  // Parse JSON
  let rawObj: unknown;
  try {
    rawObj = JSON.parse(Buffer.from(body).toString('utf-8'));
  } catch (e) {
    throw new Error(`Manifest JSON parse failed for ${appId}@${version}: ${(e as Error).message}`);
  }

  // zod validate
  const parseResult = ManifestSchema.safeParse(rawObj);
  if (!parseResult.success) {
    const messages = parseResult.error.errors
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join(', ');
    throw new Error(
      `Manifest schema validation failed for ${appId}@${version}: ${messages}`,
    );
  }

  return parseResult.data;
}
