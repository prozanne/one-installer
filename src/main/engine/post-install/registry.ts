import { renderTemplate } from '@main/engine/template';
import type { ActionHandler } from './types';
import type { RegistryValue } from '@main/platform';
import type { JournalEntryT } from '@shared/schema';

export const registryHandler: ActionHandler<'registry'> = {
  type: 'registry',
  async apply(action, ctx) {
    const createdValues: string[] = [];
    const overwroteValues: Record<string, RegistryValue> = {};
    const keyCreated = !(await ctx.platform.registryKeyExists(action.hive, action.key));

    for (const [name, val] of Object.entries(action.values)) {
      const prev = await ctx.platform.registryRead(action.hive, action.key, name);
      if (prev === null) {
        createdValues.push(name);
      } else {
        overwroteValues[name] = prev;
      }
      const data =
        val.type === 'REG_SZ' || val.type === 'REG_EXPAND_SZ'
          ? renderTemplate(String(val.data), ctx.templateContext, ctx.systemVars)
          : val.data;
      await ctx.platform.registryWrite(action.hive, action.key, name, {
        type: val.type,
        data,
      } as RegistryValue);
    }

    const entry: JournalEntryT = {
      type: 'registry',
      hive: action.hive,
      key: action.key,
      createdValues,
      overwroteValues,
      keyCreated,
      atTs: new Date().toISOString(),
    };
    return entry;
  },
  async inverse(entry, platform) {
    if (entry.type !== 'registry') return;
    for (const name of entry.createdValues) {
      try {
        await platform.registryDeleteValue(entry.hive, entry.key, name);
      } catch {
        /* ignore */
      }
    }
    for (const [name, prev] of Object.entries(entry.overwroteValues ?? {})) {
      const v = prev as RegistryValue;
      try {
        await platform.registryWrite(entry.hive, entry.key, name, v);
      } catch {
        /* ignore */
      }
    }
    if (entry.keyCreated) {
      try {
        await platform.registryDeleteKey(entry.hive, entry.key, false);
      } catch {
        /* ignore */
      }
    }
  },
};
