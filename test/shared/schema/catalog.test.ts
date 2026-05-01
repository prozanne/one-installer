import { describe, it, expect } from 'vitest';
import { CatalogSchema } from '@shared/schema/catalog';

const baseCatalog = () => ({
  schemaVersion: 1 as const,
  updatedAt: '2026-05-01T12:00:00.000Z',
  channels: ['stable' as const],
  categories: [{ id: 'agents', label: { default: 'Agents' } }],
  featured: [],
  apps: [
    {
      id: 'com.samsung.vdx.example-agent',
      displayName: { default: 'Example Agent' },
      displayDescription: { default: 'A sample agent for VDX Installer' },
      latestVersion: '1.0.0',
      packageUrl: 'https://example.invalid/agent.vdxpkg',
      category: 'agents',
      channels: ['stable' as const],
      tags: ['llm'],
      minHostVersion: '0.1.0',
      deprecated: false,
      replacedBy: null,
      addedAt: '2026-04-30T00:00:00.000Z',
    },
  ],
});

describe('CatalogSchema', () => {
  it('accepts a valid agent-catalog with packageUrl-style entries', () => {
    expect(() => CatalogSchema.parse(baseCatalog())).not.toThrow();
  });

  it('accepts entries that supply repo instead of packageUrl', () => {
    const c = baseCatalog();
    c.apps[0]!.packageUrl = undefined as never;
    (c.apps[0] as Record<string, unknown>)['repo'] = 'samsung/example-agent';
    expect(() => CatalogSchema.parse(c)).not.toThrow();
  });

  it('rejects entries that supply neither packageUrl nor repo', () => {
    const c = baseCatalog();
    c.apps[0]!.packageUrl = undefined as never;
    expect(() => CatalogSchema.parse(c)).toThrow(/packageUrl or repo/);
  });

  it('rejects bad URL in packageUrl', () => {
    const c = baseCatalog();
    c.apps[0]!.packageUrl = 'not-a-url';
    expect(() => CatalogSchema.parse(c)).toThrow();
  });

  it('accepts the optional kind hint', () => {
    const c = { ...baseCatalog(), kind: 'agent' as const };
    expect(() => CatalogSchema.parse(c)).not.toThrow();
  });
});
