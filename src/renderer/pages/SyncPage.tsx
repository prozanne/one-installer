import { useEffect, useState } from 'react';
import type { SyncStatusResT, SyncReportEventT } from '@shared/ipc-types';

/**
 * Fleet Profile Sync — surfaces the configured profile, the last reconcile
 * report, and a "Sync now" trigger.
 *
 * The page is rendered in two flavors:
 *
 *   - When `enabled: false` (no syncProfile in vdx.config.json), we still
 *     show the page but only as an explainer pointing at the config block
 *     to add. This is intentional: a fleet rollout that landed without
 *     proper config should make the absence visible, not hide the tab.
 *
 *   - When `enabled: true`, show profile name + URL + last report. Live
 *     event subscription means a background reconcile triggered by the
 *     periodic loop updates the page without a manual refresh.
 *
 * Backup/Restore controls live at the bottom — they are tied to sync
 * conceptually (export the desired-state of one host, import it on
 * another, then press Sync). Keeping them on the same tab keeps the
 * Settings page from collecting unrelated controls.
 */
export function SyncPage() {
  const [status, setStatus] = useState<SyncStatusResT | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<SyncReportEventT | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  const refresh = async () => {
    const r = await window.vdxIpc.syncStatus();
    setStatus(r);
    if (r.ok && r.lastReport) setReport(r.lastReport);
  };

  useEffect(() => {
    void refresh();
    const off = window.vdxIpc.onSyncReport((ev) => {
      setReport(ev);
      void refresh();
    });
    return off;
  }, []);

  const onSyncNow = async (dryRun: boolean) => {
    setRunning(true);
    setError(null);
    try {
      const r = await window.vdxIpc.syncRun({ dryRun });
      if (!r.ok) setError(r.error);
      else setReport(r.report);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
      void refresh();
    }
  };

  const onExport = async () => {
    const r = await window.vdxIpc.hostExportState();
    if (!r.ok) {
      setError(r.error);
      return;
    }
    // Trigger a browser download of the JSON. Works in Electron too — file://
    // pages can create blob URLs and click a link.
    const blob = new Blob([JSON.stringify(r.backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vdx-installer-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const onImportFile = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;
    setImporting(true);
    setImportMsg(null);
    setError(null);
    try {
      const text = await file.text();
      const backup = JSON.parse(text) as unknown;
      const r = await window.vdxIpc.hostImportState({
        backup: backup as never,
        reinstall: false,
      });
      if (!r.ok) setError(r.error);
      else setImportMsg(`Imported ${r.appsMerged} app entries. Press "Sync now" to reinstall.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  if (!status) {
    return (
      <div className="text-sm text-black/60">
        <h1 className="text-2xl font-semibold mb-4">Fleet Sync</h1>
        Loading status…
      </div>
    );
  }

  if (!status.ok) {
    return (
      <div className="text-sm text-rose-700">
        <h1 className="text-2xl font-semibold mb-4">Fleet Sync</h1>
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2">
          {status.error}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-baseline justify-between mb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Fleet Sync</h1>
        <div className="text-xs font-mono text-black/40">
          {status.enabled ? 'enabled' : 'disabled'}
        </div>
      </div>

      {!status.enabled && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 mb-6">
          <h2 className="font-semibold text-amber-900 mb-1">Sync is not configured</h2>
          <p className="text-sm text-amber-800">
            Add a <code className="font-mono text-xs">syncProfile</code> block to your{' '}
            <code className="font-mono text-xs">vdx.config.json</code> with{' '}
            <code className="font-mono text-xs">url</code> and{' '}
            <code className="font-mono text-xs">sigUrl</code> pointing at a signed Fleet
            Profile JSON. Once configured, this page will show the profile name, the last
            reconcile report, and let you trigger a sync on demand.
          </p>
        </div>
      )}

      {status.enabled && (
        <section className="mb-8 rounded-lg border border-black/10 bg-white p-5">
          <div className="flex items-baseline justify-between">
            <div>
              <div className="text-xs font-mono uppercase tracking-wide text-black/50">
                Profile
              </div>
              <div className="text-lg font-semibold">{status.profileName ?? '— pending fetch —'}</div>
              <a
                className="text-xs font-mono text-black/40 hover:text-teal-700"
                href={status.profileUrl ?? '#'}
                target="_blank"
                rel="noopener noreferrer"
              >
                {status.profileUrl}
              </a>
            </div>
            <div className="flex gap-2">
              <button
                className="px-3 py-1.5 text-sm rounded-md border border-black/10 hover:bg-black/5 disabled:opacity-50"
                disabled={running || status.inFlight}
                onClick={() => void onSyncNow(true)}
              >
                Dry run
              </button>
              <button
                className="px-3 py-1.5 text-sm rounded-md bg-teal-700 text-white hover:bg-teal-600 disabled:opacity-50"
                disabled={running || status.inFlight}
                onClick={() => void onSyncNow(false)}
              >
                {running || status.inFlight ? 'Syncing…' : 'Sync now'}
              </button>
            </div>
          </div>
          <div className="mt-3 text-xs text-black/50">
            Last reconcile:{' '}
            {status.lastReconciledAt
              ? new Date(status.lastReconciledAt).toLocaleString()
              : 'never'}
          </div>
        </section>
      )}

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 mb-4 text-sm text-rose-800">
          {error}
        </div>
      )}

      {report && (
        <section className="mb-8 rounded-lg border border-black/10 bg-white p-5">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="font-semibold">Last reconcile</h2>
            <span className="text-xs font-mono text-black/40">
              {report.dryRun ? 'dry-run' : 'applied'} · {report.actions.length} action(s)
            </span>
          </div>
          {report.actions.length === 0 ? (
            <div className="text-sm text-black/60 italic">
              No drift — this fleet is already in sync.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-black/50">
                <tr>
                  <th className="text-left py-1 font-medium">App</th>
                  <th className="text-left py-1 font-medium">Action</th>
                  <th className="text-left py-1 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody>
                {report.actions.map((a, i) => (
                  <tr key={i} className="border-t border-black/5">
                    <td className="py-1 font-mono text-xs">{a.appId}</td>
                    <td className={`py-1 ${actionTint(a.kind)}`}>{a.kind}</td>
                    <td className="py-1 text-xs text-black/60">{actionDetail(a)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      <section className="rounded-lg border border-black/10 bg-white p-5">
        <h2 className="font-semibold mb-2">Backup &amp; restore</h2>
        <p className="text-sm text-black/60 mb-3">
          Export this host&apos;s installed apps + settings as a JSON file. Import it on
          another host (or after a reinstall) to reseed the metadata, then press{' '}
          <strong>Sync now</strong> to reinstall the actual binaries.
        </p>
        <div className="flex gap-2 items-center">
          <button
            className="px-3 py-1.5 text-sm rounded-md border border-black/10 hover:bg-black/5"
            onClick={() => void onExport()}
          >
            Export state
          </button>
          <label className="px-3 py-1.5 text-sm rounded-md border border-black/10 hover:bg-black/5 cursor-pointer">
            {importing ? 'Importing…' : 'Import state'}
            <input type="file" accept="application/json" hidden onChange={onImportFile} />
          </label>
          {importMsg && (
            <span className="text-xs text-emerald-700 ml-2">{importMsg}</span>
          )}
        </div>
      </section>
    </div>
  );
}

function actionTint(kind: string): string {
  switch (kind) {
    case 'installed':
    case 'updated':
      return 'text-emerald-700 font-medium';
    case 'uninstalled':
      return 'text-amber-700 font-medium';
    case 'failed':
      return 'text-rose-700 font-medium';
    default:
      return 'text-black/60';
  }
}

function actionDetail(a: SyncReportEventT['actions'][number]): string {
  switch (a.kind) {
    case 'installed':
      return `v${a.version}`;
    case 'updated':
      return `${a.fromVersion} → ${a.toVersion}`;
    case 'uninstalled':
      return '';
    case 'skipped':
      return a.reason;
    case 'failed':
      return a.error;
  }
}
