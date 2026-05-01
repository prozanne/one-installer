/**
 * Helpers for shaping IPC handler errors before they cross the renderer
 * boundary. The renderer is treated as untrusted: every error message it
 * sees passes through `redact()` so paths/tokens/long hex don't leak into
 * UI banners, log dumps, or support bundles.
 */
import { redact } from '@main/logging/redact';

/**
 * Map an exception (or any unknown thrown value) to a user-safe string.
 *
 * - `AbortError` → "Cancelled" — the renderer-side UX is "user clicked
 *   cancel", not a technical fault, so we surface a friendly noun.
 * - Everything else → `redact(error.message ?? String(error))`.
 *
 * Never returns the raw `Error` object or stack trace; both can carry
 * absolute paths, environment variables, and credentials embedded by
 * upstream libraries (undici, fs, child_process).
 */
export function ipcErrorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'name' in e && (e as { name?: string }).name === 'AbortError') {
    return 'Cancelled';
  }
  const msg =
    e instanceof Error
      ? e.message
      : typeof e === 'string'
        ? e
        : String(e);
  return redact(msg);
}

/**
 * Convenience: wrap an exception in an `{ ok: false, error }` IPC reply.
 * Use this in handler `catch` blocks instead of constructing the object
 * inline — that's the single place the redact pass is enforced.
 */
export function ipcError(e: unknown): { ok: false; error: string } {
  return { ok: false, error: ipcErrorMessage(e) };
}
