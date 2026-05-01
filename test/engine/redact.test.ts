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

  describe('false-positive guards', () => {
    it('UUIDs (with dashes) are NOT masked — txid correlation must survive', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      expect(redact(`tx ${uuid} starting`)).toBe(`tx ${uuid} starting`);
    });

    it('shared/non-personal Users dirs are NOT masked', () => {
      expect(redact('/Users/Public/share/x')).toBe('/Users/Public/share/x');
      expect(redact('/Users/Shared/cache.json')).toBe('/Users/Shared/cache.json');
      expect(redact('C:\\Users\\Public\\AppData')).toBe('C:\\Users\\Public\\AppData');
      expect(redact('C:\\Users\\Default\\NTUSER.DAT')).toBe('C:\\Users\\Default\\NTUSER.DAT');
    });

    it('short ghp_-style tokens (under threshold) are preserved', () => {
      // Not a real PAT, just a comment / fixture name. 8 chars — below the
      // 20-char minimum we redact at, so should pass through.
      expect(redact('see ghp_short for fixture')).toBe('see ghp_short for fixture');
    });

    it('SHA-256 hashes ARE masked — fix sites must use 8-char prefix', () => {
      // This pins the current behaviour. If the redactor ever stops masking
      // 64-char hex, sites like payload-fetcher's truncated diagnostic could
      // be relaxed. Until then, full hashes get scrubbed and call sites
      // truncate proactively.
      const h = 'a'.repeat(64);
      expect(redact(`got ${h}`)).toBe('got [REDACTED:HEX]');
    });

    it('Bearer + Slack ordering: Bearer wins (no double-mask)', () => {
      expect(redact('Bearer xoxb-1234567890123-abcdefghijk')).toMatch(
        /Bearer \[REDACTED:BEARER\]/,
      );
    });
  });
});
