import { useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useStore } from '../store';

export function ProgressPage() {
  const navigate = useNavigate();
  const progress = useStore((s) => s.progress);
  const sideload = useStore((s) => s.sideload);
  const refreshApps = useStore((s) => s.refreshApps);
  const resetWizard = useStore((s) => s.resetWizard);

  useEffect(() => {
    if (progress?.phase === 'done') {
      void refreshApps();
    }
  }, [progress, refreshApps]);

  const isDone = progress?.phase === 'done';
  const isError = progress?.phase === 'error';

  return (
    <div className="max-w-xl">
      <h1 className="text-xl font-semibold mb-2">
        {sideload ? `Installing ${sideload.manifest.name.default}` : 'Installing'}
      </h1>
      <div className="text-sm text-black/50 mb-6">
        {progress?.message ?? 'Starting...'}
      </div>

      <div className="h-2 bg-black/5 rounded-full overflow-hidden mb-6">
        <div
          className={`h-full transition-all ${isError ? 'bg-red-500' : 'bg-teal'}`}
          style={{ width: `${progress?.percent ?? (isDone ? 100 : 5)}%` }}
        />
      </div>

      {isDone && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-md p-4 mb-4 text-sm text-emerald-900">
          Install complete.
        </div>
      )}
      {isError && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-4 text-sm text-red-900">
          <div className="font-medium mb-1">Install failed</div>
          <div className="font-mono text-xs">{progress?.message}</div>
        </div>
      )}

      {(isDone || isError) && (
        <button
          onClick={() => {
            resetWizard();
            navigate('/');
          }}
          className="text-sm px-4 py-2 rounded-md bg-teal text-white hover:bg-teal/90"
        >
          Back to apps
        </button>
      )}
    </div>
  );
}
