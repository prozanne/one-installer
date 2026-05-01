import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store';

/**
 * Updates dashboard. Lists per-app candidates surfaced by main's
 * apps:checkUpdates handler and offers an Update button for each. The
 * renderer never auto-installs — even for autoUpdate='auto' apps the
 * user click is required (silent install path is Phase 2.5; until then
 * 'auto' behaves like 'ask' visually).
 *
 * Refreshes on mount and whenever the user clicks the explicit Refresh
 * button. Background broadcasts via apps:updatesAvailable also push new
 * candidates into the store, so the list updates without a re-render
 * trigger from this page.
 */
export function UpdatesPage() {
  const navigate = useNavigate();
  const candidates = useStore((s) => s.appUpdates);
  const refreshAppUpdates = useStore((s) => s.refreshAppUpdates);
  const runAppUpdate = useStore((s) => s.runAppUpdate);
  const setError = useStore((s) => s.setError);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    void (async () => {
      setRefreshing(true);
      await refreshAppUpdates();
      setRefreshing(false);
    })();
  }, [refreshAppUpdates]);

  const handleUpdate = async (appId: string) => {
    setError(null);
    setBusy(appId);
    const res = await runAppUpdate(appId);
    setBusy(null);
    if (res.ok) navigate('/wizard');
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await refreshAppUpdates();
    setRefreshing(false);
  };

  return (
    <div className="max-w-3xl">
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">Updates</h1>
          <div className="text-sm text-black/50">
            {candidates.length === 0
              ? '모든 앱이 최신 버전입니다'
              : `${candidates.length}개 앱이 업데이트 가능`}
          </div>
        </div>
        <button
          onClick={() => void handleRefresh()}
          disabled={refreshing}
          className="text-sm px-3 py-1.5 rounded-md border border-black/10 hover:bg-black/5 disabled:opacity-40"
        >
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </header>

      {candidates.length === 0 ? (
        <div className="text-sm text-black/50 italic">
          업데이트 가능한 항목이 없습니다. 카탈로그가 갱신되면 여기 자동으로 표시됩니다.
        </div>
      ) : (
        <div className="space-y-2">
          {candidates.map((c) => (
            <div
              key={c.appId}
              className="flex items-center gap-4 px-4 py-3 bg-white border border-black/5 rounded-lg shadow-sm"
            >
              <div className="w-10 h-10 bg-teal/10 border border-teal/30 rounded-md flex items-center justify-center">
                <span className="font-mono text-teal font-semibold">
                  {c.displayName[0]?.toUpperCase() ?? '?'}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">
                  {c.displayName}
                  <span className="ml-2 text-xs text-black/40 font-mono">
                    {c.fromVersion} → {c.toVersion}
                  </span>
                </div>
                <div className="text-xs text-black/50 truncate font-mono">
                  {c.appId} · {c.kind}
                  {c.policy === 'manual' && (
                    <span className="ml-2 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
                      manual
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={() => void handleUpdate(c.appId)}
                disabled={busy === c.appId}
                className="text-sm px-3 py-1.5 rounded-md bg-teal text-white hover:bg-teal/90 disabled:opacity-40"
              >
                {busy === c.appId ? '준비 중...' : 'Update'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
