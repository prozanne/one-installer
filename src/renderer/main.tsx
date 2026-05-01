import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import './styles.css';
import { App } from './App';
import { HomePage } from './pages/HomePage';

// HomePage is the cold-start entry — bundle eagerly. Wizard / Progress / Agents
// are only reachable after a user click, so split them out to shrink the
// initial paint chunk.
const WizardPage = lazy(() =>
  import('./pages/WizardPage').then((m) => ({ default: m.WizardPage })),
);
const ProgressPage = lazy(() =>
  import('./pages/ProgressPage').then((m) => ({ default: m.ProgressPage })),
);
const AgentsPage = lazy(() =>
  import('./pages/AgentsPage').then((m) => ({ default: m.AgentsPage })),
);
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
const UpdatesPage = lazy(() =>
  import('./pages/UpdatesPage').then((m) => ({ default: m.UpdatesPage })),
);
const SyncPage = lazy(() =>
  import('./pages/SyncPage').then((m) => ({ default: m.SyncPage })),
);

// In Electron, the preload script populates `window.vdxIpc` before this
// file runs. In headless / browser mode there's no preload — fall back to
// the WebSocket-backed polyfill that exposes the same shape over the
// headless server's RPC bridge. Top-level await is supported by our
// ESM target and React renders only after this resolves.
if (!(window as Window & { vdxIpc?: unknown }).vdxIpc) {
  const mod = await import('./transport-ws');
  mod.installBrowserIpcPolyfill();
}

const root = createRoot(document.getElementById('root')!);
root.render(
  <StrictMode>
    <HashRouter>
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<HomePage />} />
          <Route
            path="wizard"
            element={
              <Suspense fallback={null}>
                <WizardPage />
              </Suspense>
            }
          />
          <Route
            path="progress"
            element={
              <Suspense fallback={null}>
                <ProgressPage />
              </Suspense>
            }
          />
          <Route
            path="agents"
            element={
              <Suspense fallback={null}>
                <AgentsPage />
              </Suspense>
            }
          />
          <Route
            path="settings"
            element={
              <Suspense fallback={null}>
                <SettingsPage />
              </Suspense>
            }
          />
          <Route
            path="updates"
            element={
              <Suspense fallback={null}>
                <UpdatesPage />
              </Suspense>
            }
          />
          <Route
            path="sync"
            element={
              <Suspense fallback={null}>
                <SyncPage />
              </Suspense>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  </StrictMode>,
);
