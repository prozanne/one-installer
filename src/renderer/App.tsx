import { useEffect } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { useStore } from './store';
import { Toast } from './components/Toast';
import { UpdateBadge } from './components/UpdateBadge';
import { HostBanner } from './components/HostBanner';

export function App() {
  const refreshApps = useStore((s) => s.refreshApps);
  const setProgress = useStore((s) => s.setProgress);
  const setAppUpdates = useStore((s) => s.setAppUpdates);
  const refreshAppUpdates = useStore((s) => s.refreshAppUpdates);
  const appUpdatesCount = useStore((s) => s.appUpdates.length);

  useEffect(() => {
    void refreshApps();
    void refreshAppUpdates();
    const off = window.vdxIpc.onProgress(setProgress);
    // Live broadcast — main pushes a fresh candidate list whenever the
    // catalog refresh produces a different fingerprint. Replace the store
    // contents wholesale; the page re-renders.
    const offUpdates = window.vdxIpc.onAppsUpdatesAvailable((ev) => {
      setAppUpdates(ev.candidates);
    });
    return () => {
      off();
      offUpdates();
    };
  }, [refreshApps, refreshAppUpdates, setProgress, setAppUpdates]);

  return (
    <div className="flex h-full">
      <Toast />
      <aside className="w-56 shrink-0 bg-sidebar border-r border-black/5 p-5 flex flex-col">
        <div className="flex items-center gap-2 mb-6">
          <div className="w-8 h-8 rounded-lg bg-teal/10 border border-teal/30 flex items-center justify-center">
            <span className="font-mono font-semibold text-teal text-lg leading-none">V</span>
          </div>
          <span className="font-semibold tracking-tight">vdx-installer</span>
        </div>
        <nav className="flex flex-col gap-1 text-sm">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `px-3 py-2 rounded-md ${isActive ? 'bg-white shadow-sm' : 'hover:bg-white/60'}`
            }
          >
            Apps
          </NavLink>
          <NavLink
            to="/agents"
            className={({ isActive }) =>
              `px-3 py-2 rounded-md ${isActive ? 'bg-white shadow-sm' : 'hover:bg-white/60'}`
            }
          >
            Agents
          </NavLink>
          <NavLink
            to="/updates"
            className={({ isActive }) =>
              `px-3 py-2 rounded-md flex items-center justify-between ${isActive ? 'bg-white shadow-sm' : 'hover:bg-white/60'}`
            }
          >
            <span>Updates</span>
            {appUpdatesCount > 0 && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-teal text-white">
                {appUpdatesCount}
              </span>
            )}
          </NavLink>
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              `px-3 py-2 rounded-md ${isActive ? 'bg-white shadow-sm' : 'hover:bg-white/60'}`
            }
          >
            Settings
          </NavLink>
        </nav>
        <UpdateBadge />
        <HostBanner />
        <div className="mt-auto text-xs text-black/40">
          <div className="font-mono">v0.1.0-dev</div>
          <div>dev mode</div>
        </div>
      </aside>
      <main className="flex-1 overflow-auto p-8">
        <Outlet />
      </main>
    </div>
  );
}
