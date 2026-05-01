import { useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useStore } from '../store';
import { formatBytes, formatBytesPerSec, formatEta } from '../components/format-bytes';

const PHASE_LABEL: Record<string, string> = {
  download: 'Downloading',
  verify: 'Verifying signature',
  extract: 'Extracting',
  actions: 'Configuring',
  arp: 'Registering',
  commit: 'Finalizing',
  rollback: 'Rolling back',
  done: 'Done',
  error: 'Failed',
};

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
  const isDownload = progress?.phase === 'download';
  const phaseLabel = progress?.phase ? PHASE_LABEL[progress.phase] ?? progress.phase : 'Starting';

  const percent =
    progress?.percent ??
    (isDone ? 100 : isDownload && progress?.downloadedBytes && progress?.totalBytes
      ? Math.min(99, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))
      : 5);

  return (
    <div className="max-w-xl">
      <h1 className="text-xl font-semibold mb-2">
        {sideload ? `Installing ${sideload.manifest.name.default}` : 'Installing'}
      </h1>
      <div className="text-sm text-black/50 mb-1">{phaseLabel}</div>
      <div className="text-xs text-black/40 mb-6 font-mono truncate">
        {progress?.message ?? 'Starting...'}
      </div>

      <div className="h-2 bg-black/5 rounded-full overflow-hidden mb-2">
        <div
          className={`h-full transition-[width] duration-100 ${isError ? 'bg-red-500' : 'bg-teal'}`}
          style={{ width: `${percent}%` }}
        />
      </div>

      {isDownload && progress && (
        <div className="grid grid-cols-3 gap-2 text-xs text-black/50 mb-6 font-mono">
          <div>
            <div className="text-black/30 uppercase tracking-wide text-[10px]">Downloaded</div>
            <div>
              {formatBytes(progress.downloadedBytes ?? 0)}
              {progress.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : ''}
            </div>
          </div>
          <div>
            <div className="text-black/30 uppercase tracking-wide text-[10px]">Speed</div>
            <div>{formatBytesPerSec(progress.bytesPerSec)}</div>
          </div>
          <div>
            <div className="text-black/30 uppercase tracking-wide text-[10px]">ETA</div>
            <div>{formatEta(progress.downloadedBytes ?? 0, progress.totalBytes, progress.bytesPerSec)}</div>
          </div>
        </div>
      )}

      {!isDownload && !isDone && !isError && <div className="mb-6" />}

      {isDone && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-md p-4 mb-4 text-sm text-emerald-900">
          Install complete.
        </div>
      )}
      {isError && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-4 text-sm text-red-900">
          <div className="font-medium mb-1">Install failed</div>
          <div className="font-mono text-xs whitespace-pre-wrap">{progress?.message}</div>
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
