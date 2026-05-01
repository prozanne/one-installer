import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CatalogTarget = z.object({
  url: z.string().url(),
  sigUrl: z.string().url(),
});

export const VdxConfigSchema = z.object({
  catalogs: z.object({
    app: CatalogTarget,
    agent: CatalogTarget,
  }),
  trust: z
    .object({
      publicKeyPath: z.string().nullable().optional(),
    })
    .optional(),
  network: z
    .object({
      timeoutMs: z.number().int().positive().default(15_000),
      userAgent: z.string().default('vdx-installer/0.1.0'),
    })
    .default({ timeoutMs: 15_000, userAgent: 'vdx-installer/0.1.0' }),
});

export type VdxConfig = z.infer<typeof VdxConfigSchema>;

/**
 * Defaults used when no `vdx.config.json` is found next to the host EXE
 * (or in the current working directory in dev). The URLs are placeholders
 * and must be overridden in production via vdx.config.json. Treat values
 * starting with `samsung.github.io` as "edit me" reminders.
 */
export const DEFAULT_CONFIG: VdxConfig = {
  catalogs: {
    app: {
      url: 'https://samsung.github.io/vdx-catalog/catalog.json',
      sigUrl: 'https://samsung.github.io/vdx-catalog/catalog.json.sig',
    },
    agent: {
      url: 'https://samsung.github.io/agent-catalog/catalog.json',
      sigUrl: 'https://samsung.github.io/agent-catalog/catalog.json.sig',
    },
  },
  network: { timeoutMs: 15_000, userAgent: 'vdx-installer/0.1.0' },
};

export function loadConfig(searchDirs: string[]): VdxConfig {
  for (const dir of searchDirs) {
    const candidate = resolve(dir, 'vdx.config.json');
    if (!existsSync(candidate)) continue;
    try {
      const raw = JSON.parse(readFileSync(candidate, 'utf-8')) as unknown;
      return VdxConfigSchema.parse(raw);
    } catch (e) {
      // Loud, structured failure — never silently fall back to defaults
      // when a config exists but is broken; the user almost certainly
      // wants to know about the typo.
      throw new Error(`Invalid vdx.config.json at ${candidate}: ${(e as Error).message}`);
    }
  }
  return DEFAULT_CONFIG;
}
