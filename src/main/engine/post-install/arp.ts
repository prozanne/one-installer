import type { Platform } from '@main/platform';
import type { JournalEntryT, Manifest } from '@shared/schema';

export interface ArpInput {
  platform: Platform;
  manifest: Manifest;
  installPath: string;
  scope: 'user' | 'machine';
  hostExePath: string;
}

export async function arpRegister(input: ArpInput): Promise<JournalEntryT> {
  const hive = input.scope === 'machine' ? 'HKLM' : 'HKCU';
  const key = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${input.manifest.id}`;
  const displayName = input.manifest.name.default;
  const values: Record<string, { type: 'REG_SZ' | 'REG_DWORD'; data: string | number }> = {
    DisplayName: { type: 'REG_SZ', data: displayName },
    DisplayVersion: { type: 'REG_SZ', data: input.manifest.version },
    Publisher: { type: 'REG_SZ', data: input.manifest.publisher },
    InstallLocation: { type: 'REG_SZ', data: input.installPath },
    EstimatedSize: { type: 'REG_DWORD', data: Math.ceil(input.manifest.size.installed / 1024) },
    UninstallString: {
      type: 'REG_SZ',
      data: `"${input.hostExePath}" --uninstall ${input.manifest.id}`,
    },
    NoModify: { type: 'REG_DWORD', data: 1 },
    NoRepair: { type: 'REG_DWORD', data: 1 },
  };
  for (const [name, v] of Object.entries(values)) {
    await input.platform.registryWrite(hive, key, name, v);
  }
  return { type: 'arp', hive, appId: input.manifest.id, atTs: new Date().toISOString() };
}

export async function arpDeregister(entry: JournalEntryT, platform: Platform): Promise<void> {
  if (entry.type !== 'arp') return;
  const key = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${entry.appId}`;
  try {
    await platform.registryDeleteKey(entry.hive, key, true);
  } catch {
    /* idempotent */
  }
}
