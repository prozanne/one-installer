import { describe, it, expect } from 'vitest';
import { redact } from '@main/logging/redact';

describe('redact', () => {
  it('masks ghp_ tokens', () => {
    expect(redact('hello ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890')).toBe(
      'hello [REDACTED:GH-PAT]',
    );
  });
  it('masks home paths', () => {
    expect(redact('/Users/case/AppData/Local/X')).toBe('~/AppData/Local/X');
  });
  it('preserves other content', () => {
    expect(redact('plain text')).toBe('plain text');
  });
});
