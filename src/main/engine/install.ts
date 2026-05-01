import { minimatch } from 'minimatch';
import type { JournalEntryT, Manifest, TransactionFileT } from '@shared/schema';
import type { Platform } from '@main/platform';
import { extractZipSafe } from '@main/packages/zip-safe';
import { applyAction, inverseAction } from './post-install';
import { renderTemplate } from './template';
import { evaluateWhen } from './when-expr';
import { arpRegister, arpDeregister } from './post-install/arp';
import type { TransactionRunner } from './transaction';
import { ok, err, type Result } from '@shared/types';

export interface InstallInput {
  manifest: Manifest;
  payloadBytes: Buffer;
  wizardAnswers: Record<string, unknown>;
  platform: Platform;
  runner: TransactionRunner;
  hostExePath: string;
  scope?: 'user' | 'machine';
}

export interface InstallSuccess {
  committed: TransactionFileT;
  installPath: string;
}

export async function runInstall(input: InstallInput): Promise<Result<InstallSuccess, string>> {
  const scope = input.scope ?? input.manifest.installScope.default;
  const sysVars = input.platform.systemVars();
  const ctx = { ...input.wizardAnswers } as Record<string, unknown>;
  const installPath = String(
    ctx.installPath ?? `${sysVars.LocalAppData}/Programs/Samsung/${input.manifest.id}`,
  );
  ctx.installPath = installPath;

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

    const platformFs = (input.platform as unknown as { fs?: import('memfs').IFs }).fs;
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
    return ok({ committed, installPath });
  } catch (e) {
    for (const entry of [...recorded].reverse()) {
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
    return err((e as Error).message);
  }
}
