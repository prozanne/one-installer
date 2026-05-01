import { describe, it, expect } from 'vitest';
import { redact } from '@main/logging/redact';

describe('redact', () => {
  it('masks classic GitHub tokens (ghp/gho/ghu/ghs/ghr)', () => {
    expect(redact('hello ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890')).toBe(
      'hello [REDACTED:GH-TOKEN]',
    );
    expect(redact('gho_AABBCCDDEEFF11223344556677')).toBe('[REDACTED:GH-TOKEN]');
  });

  it('masks fine-grained GitHub PATs', () => {
    expect(
      redact('github_pat_11ABCDEFG0_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ'),
    ).toBe('[REDACTED:GH-PAT]');
  });

  it('masks Bearer tokens', () => {
    expect(redact('Authorization: Bearer abcdef1234567890ABCDEF')).toMatch(
      /Bearer \[REDACTED:BEARER\]/,
    );
  });

  it('masks long hex strings (Ed25519 keys, SHA-256 hashes)', () => {
    const fakePubkey = 'a'.repeat(64);
    expect(redact(`Error: invalid Point 0x${fakePubkey}`)).not.toContain(fakePubkey);
    expect(redact(`Error: invalid Point 0x${fakePubkey}`)).toContain('[REDACTED:HEX]');
  });

  it('masks Slack and AWS keys', () => {
    expect(redact('xoxb-1234567890123-abcdefghijk')).toBe('[REDACTED:SLACK]');
    expect(redact('AKIAIOSFODNN7EXAMPLE')).toBe('[REDACTED:AWS]');
  });

  it('masks home paths', () => {
    expect(redact('/Users/case/AppData/Local/X')).toBe('~/AppData/Local/X');
  });

  it('preserves other content', () => {
    expect(redact('plain text')).toBe('plain text');
  });
});
