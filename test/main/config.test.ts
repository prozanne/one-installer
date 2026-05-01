import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, DEFAULT_CONFIG } from '@main/config';

describe('loadConfig', () => {
  it('returns defaults when no config file is present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vdx-config-'));
    try {
      const cfg = loadConfig([dir]);
      expect(cfg.catalogs.app.url).toBe(DEFAULT_CONFIG.catalogs.app.url);
      expect(cfg.catalogs.agent.url).toBe(DEFAULT_CONFIG.catalogs.agent.url);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads + parses a valid config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vdx-config-'));
    try {
      writeFileSync(
        join(dir, 'vdx.config.json'),
        JSON.stringify({
          catalogs: {
            app: {
              url: 'https://example.invalid/app/catalog.json',
              sigUrl: 'https://example.invalid/app/catalog.json.sig',
            },
            agent: {
              url: 'https://example.invalid/agent/catalog.json',
              sigUrl: 'https://example.invalid/agent/catalog.json.sig',
            },
          },
        }),
      );
      const cfg = loadConfig([dir]);
      expect(cfg.catalogs.agent.url).toBe('https://example.invalid/agent/catalog.json');
      expect(cfg.network.timeoutMs).toBe(15_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on a syntactically broken config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vdx-config-'));
    try {
      writeFileSync(join(dir, 'vdx.config.json'), '{ this is not json');
      expect(() => loadConfig([dir])).toThrow(/Invalid vdx.config.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on a config with non-URL strings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vdx-config-'));
    try {
      writeFileSync(
        join(dir, 'vdx.config.json'),
        JSON.stringify({
          catalogs: {
            app: { url: 'not-a-url', sigUrl: 'also-not' },
            agent: { url: 'still-not-a-url', sigUrl: 'nope' },
          },
        }),
      );
      expect(() => loadConfig([dir])).toThrow(/Invalid vdx.config.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('searches multiple dirs in order, first match wins', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'vdx-config-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'vdx-config-b-'));
    try {
      writeFileSync(
        join(dirB, 'vdx.config.json'),
        JSON.stringify({
          catalogs: {
            app: { url: 'https://b.invalid/app.json', sigUrl: 'https://b.invalid/app.sig' },
            agent: { url: 'https://b.invalid/agent.json', sigUrl: 'https://b.invalid/agent.sig' },
          },
        }),
      );
      // dirA empty, dirB has config → loader finds dirB on second pass
      const cfg = loadConfig([dirA, dirB]);
      expect(cfg.catalogs.app.url).toBe('https://b.invalid/app.json');
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});
