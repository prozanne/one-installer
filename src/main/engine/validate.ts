import { minimatch } from 'minimatch';
import { ManifestSchema, type Manifest } from '@shared/schema';
import { resolveVariables } from './template';
import { parseWhen } from './when-expr';
import { ok, err, type Result } from '@shared/types';

export interface ValidateInput {
  payloadEntries: string[];
}

const KNOWN_SYS_VARS = new Set([
  'ProgramFiles',
  'ProgramFilesX86',
  'LocalAppData',
  'Desktop',
  'StartMenu',
  'Temp',
  'InstallerVersion',
  'AppId',
  'AppVersion',
]);

export function validateManifestSemantics(
  manifest: Manifest,
  input: ValidateInput,
): Result<true, string[]> {
  ManifestSchema.parse(manifest);
  const errors: string[] = [];

  if (!manifest.installScope.supports.includes(manifest.installScope.default)) {
    errors.push(`installScope.default '${manifest.installScope.default}' not in supports`);
  }

  const wizardIds = new Set<string>();
  for (const step of manifest.wizard) {
    if ('id' in step) wizardIds.add(step.id);
  }

  const refs: { source: string; userVars: string[]; systemVars: string[] }[] = [];

  for (let i = 0; i < manifest.install.extract.length; i++) {
    const ex = manifest.install.extract[i]!;
    refs.push({ source: `install.extract[${i}].to`, ...resolveVariables(ex.to) });
    if (ex.when) {
      try {
        parseWhen(ex.when);
      } catch (e) {
        errors.push(`install.extract[${i}].when invalid: ${(e as Error).message}`);
      }
      refs.push({ source: `install.extract[${i}].when`, ...resolveVariables(ex.when) });
    }
  }

  for (let i = 0; i < manifest.postInstall.length; i++) {
    const a = manifest.postInstall[i]!;
    const tag = `postInstall[${i}]`;
    if (a.when) {
      try {
        parseWhen(a.when);
      } catch (e) {
        errors.push(`${tag}.when invalid: ${(e as Error).message}`);
      }
      refs.push({ source: `${tag}.when`, ...resolveVariables(a.when) });
    }
    if (a.type === 'shortcut') {
      refs.push({ source: `${tag}.target`, ...resolveVariables(a.target) });
    } else if (a.type === 'registry') {
      for (const [n, v] of Object.entries(a.values)) {
        if (typeof v.data === 'string') {
          refs.push({ source: `${tag}.values.${n}.data`, ...resolveVariables(v.data) });
        }
      }
    } else if (a.type === 'envPath') {
      refs.push({ source: `${tag}.add`, ...resolveVariables(a.add) });
    } else if (a.type === 'exec') {
      refs.push({ source: `${tag}.cmd`, ...resolveVariables(a.cmd) });
      if (!a.cmd.startsWith('{{installPath}}') && !a.cmd.includes('{{')) {
        errors.push(`${tag}.cmd must start with {{installPath}} (got: ${a.cmd})`);
      }
    }
  }

  for (const r of refs) {
    for (const v of r.systemVars) {
      if (!KNOWN_SYS_VARS.has(v)) errors.push(`${r.source}: unknown system var {${v}}`);
    }
    for (const v of r.userVars) {
      const root = v.split('.')[0]!;
      if (!wizardIds.has(root)) {
        errors.push(`${r.source}: variable {{${v}}} not produced by any wizard step`);
      }
    }
  }

  for (let i = 0; i < manifest.install.extract.length; i++) {
    const ex = manifest.install.extract[i]!;
    const matches = input.payloadEntries.some((p) => minimatch(p, ex.from));
    if (!matches) errors.push(`install.extract[${i}].from '${ex.from}' matches nothing in payload`);
  }

  return errors.length ? err(errors) : ok(true);
}
