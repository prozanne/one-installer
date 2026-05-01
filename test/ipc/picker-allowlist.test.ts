/**
 * picker-allowlist tests — Hard Rule 6 enforcement.
 *
 * These cover the security-critical gate that turns an IPC channel from an
 * unrestricted fs.readFile into a one-time-use, picker-mediated read. The
 * properties we care about: claim consumes, replay fails, eviction is FIFO,
 * cap is honored.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createPickerAllowlist } from '@main/ipc/picker-allowlist';
import type { PickerAllowlist } from '@main/ipc/picker-allowlist';

let allow: PickerAllowlist;

beforeEach(() => {
  allow = createPickerAllowlist();
});

describe('claim', () => {
  it('returns false for a path that was never registered', () => {
    expect(allow.claim('/etc/passwd')).toBe(false);
  });

  it('returns true exactly once per remembered path (single-use)', () => {
    allow.remember('/Users/me/sample.vdxpkg');
    expect(allow.claim('/Users/me/sample.vdxpkg')).toBe(true);
    // Replay: must fail.
    expect(allow.claim('/Users/me/sample.vdxpkg')).toBe(false);
  });

  it('does not match a path that differs by even one character', () => {
    allow.remember('/Users/me/a.vdxpkg');
    expect(allow.claim('/Users/me/A.vdxpkg')).toBe(false);
    expect(allow.claim('/Users/me/a.vdxpkg ')).toBe(false);
    expect(allow.claim('/users/me/a.vdxpkg')).toBe(false);
  });
});

describe('cap and eviction', () => {
  it('evicts the oldest entry when cap is exceeded', () => {
    const small = createPickerAllowlist({ maxPaths: 3 });
    small.remember('/a');
    small.remember('/b');
    small.remember('/c');
    small.remember('/d'); // evicts /a
    expect(small.size()).toBe(3);
    expect(small.claim('/a')).toBe(false); // evicted
    expect(small.claim('/b')).toBe(true);
    expect(small.claim('/c')).toBe(true);
    expect(small.claim('/d')).toBe(true);
  });

  it('re-staging a path moves it to the most-recent slot (no premature eviction)', () => {
    const small = createPickerAllowlist({ maxPaths: 3 });
    small.remember('/a');
    small.remember('/b');
    small.remember('/c');
    // Re-pick /a — it should now be the newest, /b the oldest.
    small.remember('/a');
    small.remember('/d'); // should evict /b, NOT /a
    expect(small.claim('/a')).toBe(true);
    expect(small.claim('/b')).toBe(false);
    expect(small.claim('/c')).toBe(true);
    expect(small.claim('/d')).toBe(true);
  });

  it('does not grow beyond the cap under churn', () => {
    const small = createPickerAllowlist({ maxPaths: 5 });
    for (let i = 0; i < 1000; i++) small.remember(`/path-${i}`);
    expect(small.size()).toBe(5);
  });
});

describe('clear', () => {
  it('drops all staged paths', () => {
    allow.remember('/a');
    allow.remember('/b');
    allow.clear();
    expect(allow.size()).toBe(0);
    expect(allow.claim('/a')).toBe(false);
  });
});
