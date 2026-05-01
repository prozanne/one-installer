import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import type { CatalogItemT } from '@shared/schema';

function pickLocalized(
  loc: { default: string; [k: string]: string } | undefined,
  fallback: string,
): string {
  return loc?.default ?? fallback;
}

export function AgentsPage() {
  const navigate = useNavigate();
  const agentCatalog = useStore((s) => s.agentCatalog);
  const refreshCatalog = useStore((s) => s.refreshCatalog);
  const installFromCatalog = useStore((s) => s.installFromCatalog);
  const apps = useStore((s) => s.apps);
  const setError = useStore((s) => s.setError);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!agentCatalog.catalog && !agentCatalog.loading) {
      void refreshCatalog('agent');
    }
  }, [agentCatalog.catalog, agentCatalog.loading, refreshCatalog]);

  async function handleInstall(item: CatalogItemT) {
    setError(null);
    setBusyId(item.id);
    const res = await installFromCatalog('agent', item.id);
    setBusyId(null);
    if (res.ok) navigate('/wizard');
  }

  const installedAgentIds = new Set(
    Object.entries(apps)
      .filter(([, a]) => a.kind === 'agent')
      .map(([id]) => id),
  );

  return (
    <div className="max-w-3xl">
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">Agent store</h1>
          <div className="text-sm text-black/50">
            Browse agents from the company agent-catalog
            {agentCatalog.fetchedAt && (
              <span className="ml-2 text-black/30">
                · refreshed{' '}
                <time dateTime={agentCatalog.fetchedAt} title={agentCatalog.fetchedAt}>
                  {new Date(agentCatalog.fetchedAt).toLocaleTimeString()}
                </time>
              </span>
            )}
          </div>
          {agentCatalog.sourceUrl && (
            <div className="text-xs text-black/40 font-mono mt-1 truncate">
              {agentCatalog.sourceUrl}
            </div>
          )}
        </div>
        <button
          onClick={() => void refreshCatalog('agent')}
          disabled={agentCatalog.loading}
          className="text-sm px-3 py-1.5 rounded-md border border-black/10 hover:bg-black/5 disabled:opacity-40"
        >
          {agentCatalog.loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </header>

      {agentCatalog.signatureValid === false && agentCatalog.catalog && (
        <div className="mb-4 px-3 py-2 bg-amber-50 border border-amber-300 text-amber-900 rounded-md text-sm">
          ⚠ Catalog signature did not verify. Items below are shown but installs may be untrusted.
        </div>
      )}

      {agentCatalog.error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-800">
          <div className="font-medium mb-1">Could not load agent catalog</div>
          <div className="font-mono text-xs">{agentCatalog.error}</div>
          <div className="mt-2 text-xs">
            Edit <code className="bg-red-100 px-1 rounded">vdx.config.json</code> to point at your
            agent-catalog GitHub Pages URL, then click Refresh.
          </div>
        </div>
      )}

      {agentCatalog.loading && !agentCatalog.catalog && (
        <div className="text-sm text-black/50">Loading catalog...</div>
      )}

      {agentCatalog.catalog && agentCatalog.catalog.apps.length === 0 && (
        <div className="text-sm text-black/50 italic">No agents in this catalog yet.</div>
      )}

      {agentCatalog.catalog && agentCatalog.catalog.apps.length > 0 && (
        <div className="space-y-2">
          {agentCatalog.catalog.apps.map((item) => {
            const installed = installedAgentIds.has(item.id);
            const name = pickLocalized(item.displayName, item.id);
            const desc = pickLocalized(item.displayDescription, '');
            return (
              <div
                key={item.id}
                className="flex items-center gap-4 px-4 py-3 bg-white border border-black/5 rounded-lg shadow-sm"
              >
                <div className="w-10 h-10 bg-teal/10 border border-teal/30 rounded-md flex items-center justify-center">
                  {item.iconUrl ? (
                    <img src={item.iconUrl} alt="" className="w-8 h-8 rounded" />
                  ) : (
                    <span className="font-mono text-teal font-semibold">{name[0]}</span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">
                    {name}
                    {item.latestVersion && (
                      <span className="ml-2 text-xs text-black/40 font-mono">
                        v{item.latestVersion}
                      </span>
                    )}
                  </div>
                  {desc && <div className="text-xs text-black/60 truncate">{desc}</div>}
                  <div className="text-xs text-black/40 truncate font-mono">{item.id}</div>
                </div>
                <button
                  onClick={() => handleInstall(item)}
                  disabled={busyId === item.id || item.deprecated}
                  className={`text-sm px-3 py-1.5 rounded-md ${
                    installed
                      ? 'border border-black/10 hover:bg-black/5'
                      : 'bg-teal text-white hover:bg-teal/90'
                  } disabled:opacity-40`}
                >
                  {busyId === item.id
                    ? 'Loading...'
                    : item.deprecated
                      ? 'Deprecated'
                      : installed
                        ? 'Reinstall'
                        : 'Install'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
