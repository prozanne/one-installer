import { z } from 'zod';

const Localized = z.object({ default: z.string() }).catchall(z.string());

export const CatalogSchema = z.object({
  schemaVersion: z.literal(1),
  updatedAt: z.string().datetime(),
  channels: z.array(z.enum(['stable', 'beta', 'internal'])),
  categories: z.array(z.object({ id: z.string(), label: Localized })),
  featured: z.array(z.string()),
  apps: z.array(
    z.object({
      id: z.string(),
      repo: z.string(),
      category: z.string(),
      channels: z.array(z.enum(['stable', 'beta', 'internal'])).min(1),
      tags: z.array(z.string()),
      minHostVersion: z.string(),
      deprecated: z.boolean(),
      replacedBy: z.string().nullable(),
      addedAt: z.string().datetime(),
    }),
  ),
});

export type CatalogT = z.infer<typeof CatalogSchema>;
