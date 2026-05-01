import { useEffect, type ReactElement } from 'react';
import { useStore } from '../store';

/**
 * Single global toast bound to `store.error`. Mounted at the top of `App.tsx`
 * with `role="alert"` + `aria-live="polite"` so screen readers announce
 * errors when they appear. Auto-dismisses after 8s; explicit close button
 * for users who want to read at their own pace.
 *
 * The renderer used to render error banners per-page (HomePage, AgentsPage,
 * WizardPage each rolled their own). Lifting the responsibility here means
 * a navigation that clears `error` no longer hides the message before the
 * user sees it, and screen-reader UX is consistent across pages.
 */
export function Toast(): ReactElement | null {
  const error = useStore((s) => s.error);
  const setError = useStore((s) => s.setError);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 8000);
    return () => clearTimeout(t);
  }, [error, setError]);

  if (!error) return null;
  return (
    <div
      role="alert"
      aria-live="polite"
      className="fixed top-4 left-1/2 -translate-x-1/2 z-50 max-w-xl w-full px-4 pointer-events-none"
    >
      <div className="pointer-events-auto bg-red-50 border border-red-200 text-red-900 rounded-lg shadow-lg px-4 py-3 flex items-start gap-3">
        <span className="flex-1 text-sm">{error}</span>
        <button
          type="button"
          className="text-red-700 hover:text-red-900 font-mono text-lg leading-none"
          aria-label="Dismiss"
          onClick={() => setError(null)}
        >
          ×
        </button>
      </div>
    </div>
  );
}
