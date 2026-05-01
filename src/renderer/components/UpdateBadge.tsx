import { useEffect } from 'react';
import { useStore } from '../store';

/**
 * Sidebar self-update badge. Surfaces the four user-visible phases of
 * the self-update lifecycle:
 *
 *   - available  → click to start download
 *   - downloading → in-progress, button disabled
 *   - ready      → click "Restart now" to apply (host will quit)
 *   - error      → red banner with retry
 *
 * The `idle` phase renders nothing — no badge, no padding shift, no clue
 * the feature exists. That's deliberate: the "Apps" sidebar is the user's
 * mental anchor for the install task; we don't want a dormant Updates
 * pill sitting there as visual noise on every launch.
 *
 * Subscribes to `update:available` IPC events at mount so a background
 * poll discovery shows up live without a re-render trigger from elsewhere.
 */
export function UpdateBadge() {
  const selfUpdate = useStore((s) => s.selfUpdate);
  const setSelfUpdate = useStore((s) => s.setSelfUpdate);
  const runSelfUpdate = useStore((s) => s.runSelfUpdate);
  const applySelfUpdate = useStore((s) => s.applySelfUpdate);

  useEffect(() => {
    const off = window.vdxIpc.onUpdateAvailable((info) => {
      // Only transition idle → available. If the user is already in
      // downloading/ready/applying we don't want a re-broadcast to clobber it.
      const cur = useStore.getState().selfUpdate;
      if (cur.phase === 'idle') {
        setSelfUpdate({ phase: 'available', info });
      }
    });
    return off;
  }, [setSelfUpdate]);

  if (selfUpdate.phase === 'idle') return null;

  const info = 'info' in selfUpdate ? selfUpdate.info : null;
  const versionLine = info ? `v${info.latestVersion} 사용 가능` : '업데이트';

  if (selfUpdate.phase === 'available') {
    return (
      <button
        type="button"
        onClick={() => void runSelfUpdate()}
        className="mt-3 text-left px-3 py-2 rounded-md bg-teal/10 border border-teal/30 text-teal hover:bg-teal/20 text-xs"
      >
        <div className="font-medium">{versionLine}</div>
        <div className="text-[11px] text-teal/80">클릭해서 다운로드</div>
      </button>
    );
  }
  if (selfUpdate.phase === 'downloading') {
    return (
      <div className="mt-3 px-3 py-2 rounded-md bg-teal/10 border border-teal/30 text-teal text-xs">
        <div className="font-medium">{versionLine}</div>
        <div className="text-[11px] text-teal/80">다운로드 중…</div>
      </div>
    );
  }
  if (selfUpdate.phase === 'ready') {
    return (
      <button
        type="button"
        onClick={() => void applySelfUpdate()}
        className="mt-3 text-left px-3 py-2 rounded-md bg-teal text-white hover:bg-teal/90 text-xs"
      >
        <div className="font-medium">지금 재시작</div>
        <div className="text-[11px] text-white/80">{versionLine}</div>
      </button>
    );
  }
  if (selfUpdate.phase === 'applying') {
    return (
      <div className="mt-3 px-3 py-2 rounded-md bg-teal text-white text-xs">
        <div className="font-medium">재시작 중…</div>
      </div>
    );
  }
  // error
  return (
    <div className="mt-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-800 text-xs">
      <div className="font-medium">업데이트 실패</div>
      <div className="text-[11px] text-red-700 break-words">{selfUpdate.error}</div>
      <button
        type="button"
        onClick={() => setSelfUpdate({ phase: 'idle' })}
        className="mt-1 text-[11px] underline"
      >
        닫기
      </button>
    </div>
  );
}
