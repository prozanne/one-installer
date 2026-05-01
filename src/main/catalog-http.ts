import { CatalogSchema, type CatalogT } from '@shared/schema';
import { verifySignature } from '@main/packages/signature';
import { ok, err, type Result } from '@shared/types';

export type CatalogKind = 'app' | 'agent';

export interface FetchInput {
  url: string;
  sigUrl: string;
  /**
   * Trust roots — any one matching pubkey passes verification (T1 union
   * semantics). Single-key callers may pass a single Uint8Array; the agent
   * catalog flow passes the operator's full trust-root array so dev/prod keys
   * can both be honored without forcing one or the other.
   */
  trustRoots: Uint8Array | Uint8Array[];
  timeoutMs: number;
  userAgent: string;
  /** ETag from the previous successful fetch, sent as If-None-Match for 304-short-circuit. */
  ifNoneMatch?: string | null;
}

export interface FetchOk {
  catalog: CatalogT;
  signatureValid: boolean;
  fetchedAt: string;
  /** Set when the server responded 304 Not Modified — caller's cached body is still valid. */
  notModified: boolean;
  /** Server-supplied ETag for the next conditional fetch. */
  etag: string | null;
}

/**
 * Pull catalog.json + catalog.json.sig over HTTPS, verify Ed25519 signature
 * against the embedded VDX public key, parse via zod schema.
 *
 * - Honors If-None-Match → 304 short-circuit so repeated tab opens cost
 *   one round-trip + zero parsing.
 * - `signatureValid: false` is on the success path: the UI surfaces a
 *   warning while still presenting the body — see spec §6.2.
 */
export async function fetchCatalog(input: FetchInput): Promise<Result<FetchOk, string>> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), input.timeoutMs);
  try {
    const baseHeaders = { 'user-agent': input.userAgent };
    const bodyHeaders: Record<string, string> = { ...baseHeaders, accept: 'application/json' };
    if (input.ifNoneMatch) bodyHeaders['if-none-match'] = input.ifNoneMatch;

    const [bodyRes, sigRes] = await Promise.all([
      fetch(input.url, { headers: bodyHeaders, signal: ac.signal }),
      fetch(input.sigUrl, {
        headers: { ...baseHeaders, accept: 'application/octet-stream' },
        signal: ac.signal,
      }),
    ]);

    if (bodyRes.status === 304) {
      // Caller's previously-fetched body is still good. We don't even read sig.
      return ok({
        catalog: undefined as unknown as CatalogT, // caller holds the cached copy; never read on this path
        signatureValid: true,
        fetchedAt: new Date().toISOString(),
        notModified: true,
        etag: bodyRes.headers.get('etag'),
      });
    }
    if (!bodyRes.ok) return err(`Catalog fetch failed: HTTP ${bodyRes.status} ${bodyRes.statusText}`);
    if (!sigRes.ok) return err(`Catalog signature fetch failed: HTTP ${sigRes.status}`);

    const bodyBytes = new Uint8Array(await bodyRes.arrayBuffer());
    const sigBytes = new Uint8Array(await sigRes.arrayBuffer());

    const trustRoots = Array.isArray(input.trustRoots) ? input.trustRoots : [input.trustRoots];
    let signatureValid = false;
    for (const pk of trustRoots) {
      if (await verifySignature({ message: bodyBytes, signature: sigBytes, publicKey: pk })) {
        signatureValid = true;
        break;
      }
    }

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
      notModified: false,
      etag: bodyRes.headers.get('etag'),
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
  /**
   * Called as bytes stream in. Caller throttles internally — emit on every
   * chunk; the throttling layer above decides whether to forward to IPC.
   */
  onProgress?: (info: { downloadedBytes: number; totalBytes: number | null }) => void;
}

/**
 * Stream the .vdxpkg bytes for an agent/app the user clicked Install on.
 * Streamed (not arrayBuffer-buffered) so a 100 MB package doesn't block the
 * event loop and the renderer can show a real progress bar.
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
    if (!res.body) return err('Package fetch returned no body stream');

    const totalHeader = res.headers.get('content-length');
    const totalBytes = totalHeader ? Number(totalHeader) : null;

    // Reading via the WHATWG ReadableStream reader keeps backpressure sane and
    // lets us count bytes without loading the whole response into memory at
    // once. We do still allocate one Buffer per chunk and concat at the end —
    // future iterations should pipe straight into a temp file once we have a
    // real on-disk cache.
    const chunks: Buffer[] = [];
    let downloaded = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      downloaded += value.byteLength;
      input.onProgress?.({ downloadedBytes: downloaded, totalBytes });
    }
    return ok(Buffer.concat(chunks, downloaded));
  } catch (e) {
    const error = e as Error;
    if (error.name === 'AbortError') return err(`Package fetch timed out after ${input.timeoutMs}ms`);
    return err(`Package fetch error: ${error.message}`);
  } finally {
    clearTimeout(t);
  }
}
