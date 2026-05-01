import type { IFs as PlatformFs } from 'memfs';
import type { JournalEntryT, Manifest } from '@shared/schema';
import type { Platform } from '@main/platform';
import { acquireAppLock } from '@main/state/lock';
import { inverseAction } from './post-install';
import { arpDeregister } from './post-install/arp';
import { renderTemplate } from './template';
import { orderedForRollback, type TransactionRunner } from './transaction';
import { ok, err, type Result } from '@shared/types';

export interface UninstallInput {
  manifest: Manifest;
  installPath: string;
  journalEntries: JournalEntryT[];
  platform: Platform;
  runner: TransactionRunner;
  scope: 'user' | 'machine';
  /** Same lock directory used by `runInstall`. See InstallInput.lockDir. */
  lockDir: string;
  /**
   * Wizard answers from the original install. The manifest's
   * `uninstall.removePaths` may template variables beyond `{{installPath}}`
   * (e.g. `{{installPath}}/{{cacheSize}}`); the spec promises that those are
   * resolvable. Pass-through from the InstalledApp record.
   */
  wizardAnswers?: Record<string, unknown>;
}

export async function runUninstall(input: UninstallInput): Promise<Result<true, string>> {
  const platformFs = (input.platform as unknown as { fs?: PlatformFs }).fs;
  const lockRes = await acquireAppLock(input.lockDir, input.manifest.id, platformFs, {
    isPidAlive: (pid) => input.platform.isPidAlive(pid),
  });
  if (!lockRes.ok) {
    return err(`Cannot acquire uninstall lock for ${input.manifest.id}: ${lockRes.error}`);
  }
  const lock = lockRes.value;

  const tx = await input.runner.begin({
    appId: input.manifest.id,
    version: input.manifest.version,
    scope: input.scope,
  });

  try {
    // Iterate by descending stepOrdinal — defends against an externally
    // mutated journal whose `steps` array order doesn't match the order
    // entries were applied. Same defensive sort `runInstall` uses.
    for (const entry of orderedForRollback(input.journalEntries)) {
      if (entry.type === 'arp') await arpDeregister(entry, input.platform);
      else await inverseAction(entry, input.platform);
      await tx.append(entry);
    }

    // Spec §3.4 says wizard answers are referenceable in uninstall paths.
    // Honor that by merging them into the template context.
    const ctx = { ...(input.wizardAnswers ?? {}), installPath: input.installPath };
    for (const p of input.manifest.uninstall.removePaths) {
      const path = renderTemplate(p, ctx, input.platform.systemVars());
      try {
        await input.platform.rmDir(path, { recursive: true });
      } catch {
        /* idempotent */
      }
    }

    await tx.commit();
    await lock.release();
    return ok(true);
  } catch (e) {
    await tx.rollback((e as Error).message);
    await lock.release();
    return err((e as Error).message);
  }
}
