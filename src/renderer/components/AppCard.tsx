import type { InstalledAppT } from '@shared/schema';

interface Props {
  appId: string;
  app: InstalledAppT;
  onUninstall: () => void;
  busy: boolean;
}

export function AppCard({ appId, app, onUninstall, busy }: Props) {
  return (
    <div className="flex items-center gap-4 px-4 py-3 bg-white border border-black/5 rounded-lg shadow-sm">
      <div className="w-10 h-10 bg-teal/10 border border-teal/30 rounded-md flex items-center justify-center">
        <span className="font-mono text-teal font-semibold">
          {app.manifestSnapshot.name.default[0]}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{app.manifestSnapshot.name.default}</div>
        <div className="text-xs text-black/50 truncate">
          {appId} · v{app.version} · {app.installScope}
        </div>
        <div className="text-xs text-black/40 truncate">{app.installPath}</div>
      </div>
      <button
        onClick={onUninstall}
        disabled={busy}
        className="text-sm px-3 py-1.5 rounded-md border border-black/10 hover:border-black/30 hover:bg-black/5 disabled:opacity-40"
      >
        {busy ? 'Removing...' : 'Uninstall'}
      </button>
    </div>
  );
}
