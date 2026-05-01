import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import { DropZone } from '../components/DropZone';
import { AppCard } from '../components/AppCard';

export function HomePage() {
  const navigate = useNavigate();
  const { apps, loadingApps, refreshApps, startSideload, error, setError } = useStore();
  const [busyApp, setBusyApp] = useState<string | null>(null);

  async function handlePicked(path: string) {
    setError(null);
    const res = await startSideload(path);
    if (res.ok) navigate('/wizard');
  }

  async function handlePickClick() {
    const res = await window.vdxIpc.pickVdxpkg();
    if (!res.canceled && res.filePaths && res.filePaths[0]) {
      void handlePicked(res.filePaths[0]);
    }
  }

  async function handleUninstall(appId: string) {
    setBusyApp(appId);
    const res = await window.vdxIpc.uninstallRun({ appId });
    setBusyApp(null);
    if (!res.ok) setError(res.error);
    await refreshApps();
  }

  const appEntries = Object.entries(apps);

  return (
    <div className="max-w-3xl">
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">Installed apps</h1>
          <div className="text-sm text-black/50">
            {appEntries.length} installed · sideload-only mode
          </div>
        </div>
        <button
          onClick={handlePickClick}
          className="text-sm px-4 py-2 rounded-md bg-teal text-white hover:bg-teal/90"
        >
          Open package...
        </button>
      </header>

      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-800 flex justify-between gap-4">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-red-600 hover:text-red-900">
            Dismiss
          </button>
        </div>
      )}

      {loadingApps ? (
        <div className="text-sm text-black/50">Loading...</div>
      ) : appEntries.length === 0 ? (
        <div className="text-sm text-black/50 italic">No apps installed yet.</div>
      ) : (
        <div className="space-y-2">
          {appEntries.map(([id, app]) => (
            <AppCard
              key={id}
              appId={id}
              app={app}
              onUninstall={() => handleUninstall(id)}
              busy={busyApp === id}
            />
          ))}
        </div>
      )}

      <DropZone onPick={handlePicked} />
    </div>
  );
}
