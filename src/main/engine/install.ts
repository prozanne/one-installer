import { minimatch } from 'minimatch';
import { posix as pathPosix } from 'node:path';
import type { JournalEntryT, Manifest, TransactionFileT } from '@shared/schema';
import type { Platform } from '@main/platform';
import { extractZipSafe } from '@main/packages/zip-safe';
import { acquireAppLock } from '@main/state/lock';
import { applyAction, inverseAction } from './post-install';
import { renderTemplate } from './template';
import { evaluateWhen } from './when-expr';
import { arpRegister, arpDeregister } from './post-install/arp';
import { orderedForRollback, type TransactionRunner } from './transaction';
import { ok, err, type Result } from '@shared/types';

export interface InstallInput {
  manifest: Manifest;
  payloadBytes: Buffer;
  wizardAnswers: Record<string, unknown>;
  platform: Platform;
  runner: TransactionRunner;
  hostExePath: string;
  /**
   * Directory for advisory per-app lockfiles. Required: a missing lock means
   * two host instances can race the same install and corrupt journal+registry.
   * Production callers wire this to `paths.locksDir(baseDir)`; tests can pass
   * any directory inside the mock fs.
   */
  lockDir: string;
  scope?: 'user' | 'machine';
}

export interface InstallSuccess {
  committed: TransactionFileT;
  installPath: string;
}

/**
 * Normalise to forward slashes so the prefix-containment check is comparing
 * apples to apples regardless of how the wizard answers came in. We do NOT
 * resolve symlinks (we never trust user-supplied symlinks anyway); pure
 * path arithmetic is enough to defeat traversal and UNC redirection.
 */
function normaliseForCheck(p: string): string {
  return pathPosix.normalize(p.replace(/\\/g, '/'));
}

/**
 * Reject installPath that escapes the sanctioned prefix. Without this gate a
 * compromised renderer could pass `installPath: "C:/Windows/System32"` and
 * the engine would happily write payload there + register ARP. The check is
 * a pure prefix test against the scope-appropriate root.
 */
function isInstallPathPermitted(
  installPath: string,
  scope: 'user' | 'machine',
  sysVars: Record<string, string>,
): boolean {
  const norm = normaliseForCheck(installPath);
  // Reject UNC outright — no \\server\share install destination.
  if (norm.startsWith('//')) return false;
  // Must be absolute. POSIX-style absolute (`/...`) or Windows drive (`C:/...`).
  if (!pathPosix.isAbsolute(norm) && !/^[A-Za-z]:\//.test(norm)) return false;
  const root = scope === 'machine' ? sysVars['ProgramFiles'] : sysVars['LocalAppData'];
  if (!root) return false;
  const expected = `${normaliseForCheck(root)}/${scope === 'machine' ? 'Samsung' : 'Programs/Samsung'}`;
  return norm === expected || norm.startsWith(`${expected}/`);
}

export async function runInstall(input: InstallInput): Promise<Result<InstallSuccess, string>> {
  const scope = input.scope ?? input.manifest.installScope.default;
  const sysVars = input.platform.systemVars();
  const ctx = { ...input.wizardAnswers } as Record<string, unknown>;
  const installPath = String(
    ctx.installPath ?? `${sysVars.LocalAppData}/Programs/Samsung/${input.manifest.id}`,
  );
  if (!isInstallPathPermitted(installPath, scope, sysVars)) {
    return err(
      `installPath out of scope: '${installPath}' must be under ` +
        (scope === 'machine'
          ? `${sysVars.ProgramFiles}/Samsung`
          : `${sysVars.LocalAppData}/Programs/Samsung`),
    );
  }
  ctx.installPath = installPath;

  const platformFs = (input.platform as unknown as { fs?: import('memfs').IFs }).fs;
  const lockRes = await acquireAppLock(input.lockDir, input.manifest.id, platformFs, {
    isPidAlive: (pid) => input.platform.isPidAlive(pid),
  });
  if (!lockRes.ok) {
    return err(`Cannot acquire install lock for ${input.manifest.id}: ${lockRes.error}`);
  }
  const lock = lockRes.value;

  const tx = await input.runner.begin({
    appId: input.manifest.id,
    version: input.manifest.version,
    scope,
  });
  const ctxForActions = {
    platform: input.platform,
    templateContext: ctx,
    systemVars: { ...sysVars, AppId: input.manifest.id, AppVersion: input.manifest.version },
    installPath,
    appId: input.manifest.id,
    payloadDir: installPath,
  };
  const recorded: JournalEntryT[] = [];

  try {
    await input.platform.ensureDir(installPath);

    const extractRes = await extractZipSafe({
      zipBytes: input.payloadBytes,
      destDir: installPath,
      ...(platformFs ? { fs: platformFs } : {}),
    });

    const wantPaths = new Set<string>();
    for (const rule of input.manifest.install.extract) {
      if (!evaluateWhen(rule.when, ctx)) continue;
      const target = renderTemplate(rule.to, ctx, ctxForActions.systemVars);
      for (const f of extractRes.files) {
        if (minimatch(f, rule.from)) {
          wantPaths.add(f);
          if (target !== installPath) {
            await input.platform.ensureDir(target);
            await input.platform.moveFile(`${installPath}/${f}`, `${target}/${f}`, {
              overwrite: true,
            });
          }
        }
      }
    }
    for (const f of extractRes.files) {
      if (!wantPaths.has(f)) {
        try {
          await input.platform.rmFile(`${installPath}/${f}`);
        } catch {
          /* ignore */
        }
      }
    }
    const extractEntry: JournalEntryT = {
      type: 'extract',
      files: [...wantPaths],
      atTs: new Date().toISOString(),
    };
    await tx.append(extractEntry);
    recorded.push(extractEntry);

    for (const action of input.manifest.postInstall) {
      const entry = await applyAction(action, ctxForActions);
      if (entry) {
        await tx.append(entry);
        recorded.push(entry);
      }
    }

    const arpEntry = await arpRegister({
      platform: input.platform,
      manifest: input.manifest,
      installPath,
      scope,
      hostExePath: input.hostExePath,
    });
    await tx.append(arpEntry);
    recorded.push(arpEntry);

    const committed = await tx.commit();
    await lock.release();
    return ok({ committed, installPath });
  } catch (e) {
    for (const entry of orderedForRollback(recorded)) {
      try {
        if (entry.type === 'arp') await arpDeregister(entry, input.platform);
        else await inverseAction(entry, input.platform);
      } catch {
        /* continue rolling back */
      }
    }
    try {
      await input.platform.rmDir(installPath, { recursive: true });
    } catch {
      /* ignore */
    }
    await tx.rollback((e as Error).message);
    await lock.release();
    return err((e as Error).message);
  }
}
