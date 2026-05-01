/**
 * CSP policy tests — Hard Rule 13 enforcement.
 *
 * The actual injection happens in `electron-main.ts` via
 * `session.webRequest.onHeadersReceived`. What we test here is the policy
 * string itself: the prod policy must be strict (no eval, no remote scripts,
 * no network), and the dev policy must contain the Vite relaxations needed
 * for HMR but nothing more.
 */
import { describe, it, expect } from 'vitest';
import { computeCsp } from '@main/ipc/csp';

describe('prod CSP (devMode=false)', () => {
  const csp = computeCsp(false);

  it('locks network down with connect-src none', () => {
    expect(csp).toMatch(/connect-src\s+'none'/);
  });

  it('blocks eval and inline scripts', () => {
    expect(csp).toMatch(/script-src\s+'self'(?!\s+(?:'unsafe-eval'|'unsafe-inline'))/);
    expect(csp).not.toMatch(/'unsafe-eval'/);
    // The single inline-script allowance only applies in dev — prod must reject.
    const scriptDirective = csp.match(/script-src[^;]+/)?.[0] ?? '';
    expect(scriptDirective).not.toMatch(/'unsafe-inline'/);
  });

  it('does not whitelist localhost', () => {
    expect(csp).not.toMatch(/localhost/);
    expect(csp).not.toMatch(/ws:/);
    expect(csp).not.toMatch(/http:\/\//);
  });

  it("keeps style 'unsafe-inline' for React style injection", () => {
    expect(csp).toMatch(/style-src[^;]*'unsafe-inline'/);
  });

  it('allows data: img + font (logo, embedded glyphs)', () => {
    expect(csp).toMatch(/img-src[^;]*data:/);
    expect(csp).toMatch(/font-src[^;]*data:/);
  });

  it('has a default-src self fallback', () => {
    expect(csp).toMatch(/default-src\s+'self'/);
  });
});

describe('dev CSP (devMode=true)', () => {
  const csp = computeCsp(true);

  it('opens script-src to localhost http/ws for Vite HMR', () => {
    expect(csp).toMatch(/script-src[^;]*http:\/\/localhost:\*/);
    expect(csp).toMatch(/script-src[^;]*ws:\/\/localhost:\*/);
  });

  it('allows unsafe-eval for dev module loader', () => {
    expect(csp).toMatch(/script-src[^;]*'unsafe-eval'/);
  });

  it('allows connect-src to localhost only — never wildcard', () => {
    expect(csp).toMatch(/connect-src\s+'self'\s+ws:\/\/localhost:\*\s+http:\/\/localhost:\*/);
    expect(csp).not.toMatch(/connect-src\s*\*/);
  });

  it('does not whitelist external hosts', () => {
    // Anything not 'self', data:, or *localhost* is rejected. Quick proxy:
    // strip allowed tokens and assert no other hostname survives.
    const allowed = /'self'|'unsafe-inline'|'unsafe-eval'|'none'|data:|http:\/\/localhost:\*|ws:\/\/localhost:\*|default-src|script-src|style-src|img-src|connect-src|font-src|;|\s/g;
    const residual = csp.replace(allowed, '');
    expect(residual).toBe('');
  });
});
