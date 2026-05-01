/**
 * Fetch + verify a Fleet Profile Sync JSON.
 *
 * Same pattern as `catalog-http.ts` for the agent catalog: detached `.sig`
 * alongside the body, parallel fetches, Ed25519 verification against the
 * configured `trustRoots` union, zod parse on the body. Distinct module so
 * the trust-chain / replay-defense logic for profiles stays readable on its
 * own — it shares conceptual surface with the catalog but the timing rules
 * (intervalMin) and consumer (reconcile loop, not UI) differ.
 *
 * Replay defense: callers persist the highest `updatedAt` they've ever
 * accepted (passed in as `freshnessAnchor`). A profile body whose
 * `updatedAt` is older is rejected. Same 60s clock-skew tolerance as the
 * catalog freshness gate.
 */
import { SyncProfileSchema, type SyncProfileT } from '@shared/schema';
import { verifySignature } from '@main/packages/signature';
import { ok, err, type Result } from '@shared/types';

export interface FetchProfileInput {
  url: string;
  sigUrl: string;
  /** Trust roots — any matching pubkey passes (T1 union semantics). */
  trustRoots: Uint8Array[];
  timeoutMs: number;
  userAgent: string;
  /**
   * Highest `updatedAt` we've ever accepted. Caller persists this in
   * `installed.json#syncProfileFreshness`. A profile whose `updatedAt` is
   * older is rejected as a replay. Optional on first launch.
   */
  freshnessAnchor?: string | null;
}

export interface FetchProfileOk {
  profile: SyncProfileT;
  signatureValid: boolean;
  fetchedAt: string;
}

const SIXTY_SECONDS_MS = 60_000;

/**
 * Fetch the profile JSON + sig, verify, parse, replay-check.
 *
 * Distinct from the catalog flow in that profiles are NOT served from a
 * 304-eligible cache — they're small, the server may not return ETags,
 * and the reconcile cadence is dictated by the operator (intervalMin). We
 * always re-fetch on the schedule.
 *
 * Returns `signatureValid: false` only if both fetches succeeded but no
 * trust root matched — the caller can show a banner and refuse to apply.
 * Network errors / HTTP non-2xx / parse errors all return Result.err.
 */
export async function fetchProfile(input: FetchProfileInput): Promise<Result<FetchProfileOk, string>> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), input.timeoutMs);
  try {
    const baseHeaders = { 'user-agent': input.userAgent };
    const [bodyRes, sigRes] = await Promise.all([
      fetch(input.url, {
        headers: { ...baseHeaders, accept: 'application/json' },
        signal: ac.signal,
      }),
      fetch(input.sigUrl, {
        headers: { ...baseHeaders, accept: 'application/octet-stream' },
        signal: ac.signal,
      }),
    ]);

    if (!bodyRes.ok) return err(`Profile fetch failed: HTTP ${bodyRes.status} ${bodyRes.statusText}`);
    if (!sigRes.ok) return err(`Profile signature fetch failed: HTTP ${sigRes.status}`);

    const bodyBytes = new Uint8Array(await bodyRes.arrayBuffer());
    const sigBytes = new Uint8Array(await sigRes.arrayBuffer());

    let signatureValid = false;
    for (const pk of input.trustRoots) {
      if (await verifySignature({ message: bodyBytes, signature: sigBytes, publicKey: pk })) {
        signatureValid = true;
        break;
      }
    }

    let profile: SyncProfileT;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bodyBytes)) as unknown;
      profile = SyncProfileSchema.parse(parsed);
    } catch (e) {
      return err(`Profile body invalid: ${(e as Error).message}`);
    }

    // Replay defense: clamped 60s skew tolerance — slightly older bodies
    // are accepted to absorb operator-clock drift, but the system never
    // accepts a profile that's substantially older than what it last saw.
    if (input.freshnessAnchor) {
      const anchor = Date.parse(input.freshnessAnchor);
      const incoming = Date.parse(profile.updatedAt);
      if (Number.isFinite(anchor) && Number.isFinite(incoming) && incoming + SIXTY_SECONDS_MS < anchor) {
        return err(
          `Profile replay refused: incoming updatedAt=${profile.updatedAt} older than anchor=${input.freshnessAnchor}`,
        );
      }
    }

    return ok({
      profile,
      signatureValid,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    const error = e as Error;
    if (error.name === 'AbortError') return err(`Profile fetch timed out after ${input.timeoutMs}ms`);
    return err(`Profile fetch error: ${error.message}`);
  } finally {
    clearTimeout(t);
  }
}
