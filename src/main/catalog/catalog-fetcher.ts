/**
 * fetchCatalogVerified — fetch, verify, and parse the catalog via a PackageSource.
 *
 * Calls source.fetchCatalog, verifies Ed25519 signature, zod-parses result.
 * SourceErrors surface unchanged. Sig/zod failures throw plain Error.
 *
 * @see docs/superpowers/specs/2026-05-01-package-source-abstraction.md §5.2
 */
import type { PackageSource } from '@shared/source/package-source';
import { CatalogSchema } from '@shared/schema/catalog';
import type { CatalogT } from '@shared/schema/catalog';
import { verifyDetached } from '@main/packages/signature';

export interface FetchCatalogVerifiedOpts {
  trustRoots: Uint8Array[];
  cachedEtag?: string;
  signal?: AbortSignal;
}

export type FetchCatalogVerifiedResult =
  | { catalog: CatalogT; etag?: string }
  | { notModified: true };

/**
 * Fetch and verify the catalog.
 *
 * - Calls `source.fetchCatalog` (passes etag for conditional GET).
 * - If notModified, returns `{ notModified: true }`.
 * - Verifies signature against ALL provided trustRoots (passes if any match).
 * - zod-parses the catalog JSON.
 * - Surfaces SourceError unchanged (re-throws).
 * - Throws plain Error for sig or zod failures.
 */
export async function fetchCatalogVerified(
  source: PackageSource,
  opts: FetchCatalogVerifiedOpts,
): Promise<FetchCatalogVerifiedResult> {
  const result = await source.fetchCatalog({
    etag: opts.cachedEtag,
    signal: opts.signal,
  });

  if (result.notModified) {
    return { notModified: true };
  }

  const { body, sig, etag } = result;

  if (!body || !sig) {
    throw new Error('fetchCatalog returned notModified:false but body or sig is missing');
  }

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
    throw new Error('Catalog signature verification failed: signature does not match any trust root');
  }

  // Parse JSON
  let rawObj: unknown;
  try {
    rawObj = JSON.parse(Buffer.from(body).toString('utf-8'));
  } catch (e) {
    throw new Error(`Catalog JSON parse failed: ${(e as Error).message}`);
  }

  // zod validate
  const parseResult = CatalogSchema.safeParse(rawObj);
  if (!parseResult.success) {
    const messages = parseResult.error.errors
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join(', ');
    throw new Error(`Catalog schema validation failed: ${messages}`);
  }

  return { catalog: parseResult.data, etag };
}
