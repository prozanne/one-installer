import { describe, it, expect } from 'vitest';
import { ok, err, isOk, isErr, type Result } from '@shared/types';

describe('Result', () => {
  it('ok wraps value', () => {
    const r: Result<number, string> = ok(42);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toBe(42);
  });

  it('err wraps error', () => {
    const r: Result<number, string> = err('boom');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error).toBe('boom');
  });
});
