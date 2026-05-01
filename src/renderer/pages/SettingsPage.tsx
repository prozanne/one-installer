import { useEffect, useState, type ReactElement } from 'react';
import type { Settings } from '@shared/ipc-types';
import { useStore } from '../store';

/**
 * Minimal settings page. Loads via `settings:get`, writes via `settings:set`.
 * The renderer-side state is whatever the last-fetched store gives us; we
 * don't optimistically mirror, since `settings:set` returns the canonical
 * post-patch object and that's what we render after each save.
 */
export function SettingsPage(): ReactElement {
  const setError = useStore((s) => s.setError);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [autoLaunch, setAutoLaunch] = useState<{ enabled: boolean; supported: boolean } | null>(
    null,
  );

  useEffect(() => {
    void (async () => {
      const res = await window.vdxIpc.settingsGet();
      if (res.ok) setSettings(res.settings);
      else setError(res.error);
      const al = await window.vdxIpc.hostGetAutoLaunch();
      if (al.ok) setAutoLaunch({ enabled: al.enabled, supported: al.supported });
    })();
  }, [setError]);

  const toggleAutoLaunch = async (v: boolean) => {
    setSaving(true);
    const res = await window.vdxIpc.hostSetAutoLaunch({ enabled: v });
    setSaving(false);
    if (res.ok) setAutoLaunch((cur) => (cur ? { ...cur, enabled: res.enabled } : cur));
    else setError(res.error);
  };

  const patch = async (p: Partial<Settings>) => {
    setSaving(true);
    const res = await window.vdxIpc.settingsSet({ patch: p });
    setSaving(false);
    if (res.ok) setSettings(res.settings);
    else setError(res.error);
  };

  if (!settings) {
    return <div className="text-sm text-black/40">Loading…</div>;
  }

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <Section title="Channel">
        <Row label="Update channel" hint="Determines which catalog channel apps and the host pull from.">
          <select
            className="border border-black/10 rounded px-2 py-1 bg-white"
            value={settings.updateChannel}
            disabled={saving}
            onChange={(e) => void patch({ updateChannel: e.target.value as Settings['updateChannel'] })}
          >
            <option value="stable">stable</option>
            <option value="beta">beta</option>
            <option value="internal">internal</option>
          </select>
        </Row>
      </Section>

      <Section title="Updates">
        <Row label="Host updates" hint="What VDX does when a newer installer is available.">
          <select
            className="border border-black/10 rounded px-2 py-1 bg-white"
            value={settings.autoUpdateHost}
            disabled={saving}
            onChange={(e) =>
              void patch({ autoUpdateHost: e.target.value as Settings['autoUpdateHost'] })
            }
          >
            <option value="auto">auto</option>
            <option value="ask">ask</option>
            <option value="manual">manual</option>
          </select>
        </Row>
        <Row label="App updates" hint="What VDX does when an installed app has a newer version.">
          <select
            className="border border-black/10 rounded px-2 py-1 bg-white"
            value={settings.autoUpdateApps}
            disabled={saving}
            onChange={(e) =>
              void patch({ autoUpdateApps: e.target.value as Settings['autoUpdateApps'] })
            }
          >
            <option value="auto">auto</option>
            <option value="ask">ask</option>
            <option value="manual">manual</option>
          </select>
        </Row>
      </Section>

      <Section title="Behaviour">
        {autoLaunch && autoLaunch.supported && (
          <Toggle
            label="Start automatically at login"
            hint="Launches VDX Installer in the system tray on login. Available on Windows, macOS, and Linux."
            checked={autoLaunch.enabled}
            disabled={saving}
            onChange={(v) => void toggleAutoLaunch(v)}
          />
        )}
        <Toggle
          label="Run in tray when window is closed"
          checked={settings.trayMode}
          disabled={saving}
          onChange={(v) => void patch({ trayMode: v })}
        />
        <Toggle
          label="Send anonymous telemetry"
          checked={settings.telemetry}
          disabled={saving}
          onChange={(v) => void patch({ telemetry: v })}
        />
        <Toggle
          label="Developer mode"
          hint="Accept signatures from the per-device dev key. Disabled in packaged user builds."
          checked={settings.developerMode}
          disabled={saving}
          onChange={(v) => void patch({ developerMode: v })}
        />
      </Section>

      <Section title="Diagnostics">
        <div className="flex gap-3">
          <button
            className="px-3 py-1.5 rounded-md bg-white border border-black/10 hover:bg-black/[0.02] text-sm"
            type="button"
            onClick={() => void window.vdxIpc.diagOpenLogs()}
          >
            Open logs folder
          </button>
          <button
            className="px-3 py-1.5 rounded-md bg-white border border-black/10 hover:bg-black/[0.02] text-sm"
            type="button"
            onClick={() => void window.vdxIpc.diagExport()}
          >
            Export diagnostic bundle
          </button>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xs uppercase tracking-wider text-black/50 font-semibold">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="flex-1">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-black/50 mt-0.5">{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Row label={label} hint={hint}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4"
      />
    </Row>
  );
}
