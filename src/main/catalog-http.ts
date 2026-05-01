import { CatalogSchema, type CatalogT } from '@shared/schema';
import { verifySignature } from '@main/packages/signature';
import { ok, err, type Result } from '@shared/types';

export type CatalogKind = 'app' | 'agent';

export interface FetchInput {
  url: string;
  sigUrl: string;
  publicKey: Uint8Array;
  timeoutMs: number;
  userAgent: string;
}

export interface FetchOk {
  catalog: CatalogT;
  signatureValid: boolean;
  fetchedAt: string;
}

/**
 * Pull catalog.json + catalog.json.sig over HTTPS, verify Ed25519 signature
 * against the embedded VDX public key, parse via zod schema. Returns a
 * `signatureValid: false` on the success path (instead of failing) so the
 * UI can surface a warning while still presenting the catalog body — the
 * caller decides how strictly to enforce signature requirements (see spec
 * §6.2 "verification rules").
 */
export async function fetchCatalog(input: FetchInput): Promise<Result<FetchOk, string>> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), input.timeoutMs);
  try {
    const headers = { 'user-agent': input.userAgent, accept: 'application/json' };
    const [bodyRes, sigRes] = await Promise.all([
      fetch(input.url, { headers, signal: ac.signal }),
      fetch(input.sigUrl, {
        headers: { ...headers, accept: 'application/octet-stream' },
        signal: ac.signal,
      }),
    ]);
    if (!bodyRes.ok) return err(`Catalog fetch failed: HTTP ${bodyRes.status} ${bodyRes.statusText}`);
    if (!sigRes.ok) return err(`Catalog signature fetch failed: HTTP ${sigRes.status}`);

    const bodyBytes = new Uint8Array(await bodyRes.arrayBuffer());
    const sigBytes = new Uint8Array(await sigRes.arrayBuffer());

    const signatureValid = await verifySignature({
      message: bodyBytes,
      signature: sigBytes,
      publicKey: input.publicKey,
    });

    let catalog: CatalogT;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bodyBytes)) as unknown;
      catalog = CatalogSchema.parse(parsed);
    } catch (e) {
      return err(`Catalog body invalid: ${(e as Error).message}`);
    }

    return ok({
      catalog,
      signatureValid,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    const error = e as Error;
    if (error.name === 'AbortError') return err(`Catalog fetch timed out after ${input.timeoutMs}ms`);
    return err(`Catalog fetch error: ${error.message}`);
  } finally {
    clearTimeout(t);
  }
}

export interface FetchPackageInput {
  url: string;
  timeoutMs: number;
  userAgent: string;
}

/**
 * Stream the .vdxpkg bytes for an agent/app the user clicked Install on.
 * Returned bytes are passed straight to `parseVdxpkg`; the resulting
 * `parsedVdxpkg.signatureValid` is what the renderer actually surfaces
 * to the user (catalog signature is a coarser gate).
 */
export async function fetchPackage(input: FetchPackageInput): Promise<Result<Buffer, string>> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), input.timeoutMs);
  try {
    const res = await fetch(input.url, {
      headers: { 'user-agent': input.userAgent, accept: 'application/octet-stream' },
      signal: ac.signal,
    });
    if (!res.ok) return err(`Package fetch failed: HTTP ${res.status} ${res.statusText}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    return ok(bytes);
  } catch (e) {
    const error = e as Error;
    if (error.name === 'AbortError') return err(`Package fetch timed out after ${input.timeoutMs}ms`);
    return err(`Package fetch error: ${error.message}`);
  } finally {
    clearTimeout(t);
  }
}
