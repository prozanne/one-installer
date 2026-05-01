/**
 * Content-Security-Policy strings for the renderer.
 *
 * Computed in main and injected via `session.webRequest.onHeadersReceived`
 * so the policy applies to BOTH the prod `file://` load and the dev Vite
 * `http://localhost` load. A `<meta>` tag in index.html would not cover
 * preconnects and is not injected by Vite in dev anyway.
 *
 * Two policies, switched by whether ELECTRON_RENDERER_URL is set at boot:
 *
 *   - prod: lockdown — `connect-src 'none'` (network must go through main IPC),
 *     `script-src 'self'` (no eval, no inline), `style-src 'self' 'unsafe-inline'`
 *     because React injects style tags, `img-src 'self' data:`, fonts data:.
 *   - dev:  Vite-friendly relaxations — allow http/ws on localhost for HMR,
 *     `'unsafe-inline'` + `'unsafe-eval'` for the dev module loader.
 *
 * Per critique §6.6 / Hard Rule 13.
 */

const PROD_CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "connect-src 'none'; " +
  "font-src 'self' data:";

const DEV_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:* ws://localhost:*; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: http://localhost:*; " +
  "connect-src 'self' ws://localhost:* http://localhost:*; " +
  "font-src 'self' data:";

/**
 * Compute the CSP header string. Pure function so the policy is testable
 * without booting Electron / Vite.
 *
 * @param devMode true when ELECTRON_RENDERER_URL is set (Vite HMR active).
 */
export function computeCsp(devMode: boolean): string {
  return devMode ? DEV_CSP : PROD_CSP;
}
