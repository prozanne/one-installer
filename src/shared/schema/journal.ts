import { z } from 'zod';

export const JournalEntry = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('extract'),
    files: z.array(z.string()),
    atTs: z.string().datetime(),
  }),
  z.object({
    type: z.literal('shortcut'),
    path: z.string(),
    atTs: z.string().datetime(),
  }),
  z.object({
    type: z.literal('registry'),
    hive: z.enum(['HKCU', 'HKLM']),
    key: z.string(),
    createdValues: z.array(z.string()),
    overwroteValues: z.record(z.string(), z.unknown()).optional(),
    keyCreated: z.boolean(),
    atTs: z.string().datetime(),
  }),
  z.object({
    type: z.literal('envPath'),
    scope: z.enum(['user', 'machine']),
    added: z.string(),
    atTs: z.string().datetime(),
  }),
  z.object({
    type: z.literal('exec'),
    cmd: z.string(),
    exitCode: z.number().int(),
    atTs: z.string().datetime(),
  }),
  z.object({
    type: z.literal('arp'),
    hive: z.enum(['HKCU', 'HKLM']),
    appId: z.string(),
    atTs: z.string().datetime(),
  }),
]);

export type JournalEntryT = z.infer<typeof JournalEntry>;

export const TransactionStatus = z.enum([
  'pending',
  'extracting',
  'running-actions',
  'sealing',
  'committed',
  'rolled-back',
  'abandoned',
]);

export const TransactionFile = z.object({
  txid: z.string().uuid(),
  appId: z.string(),
  version: z.string(),
  scope: z.enum(['user', 'machine']),
  status: TransactionStatus,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  steps: z.array(JournalEntry),
});

export type TransactionFileT = z.infer<typeof TransactionFile>;
