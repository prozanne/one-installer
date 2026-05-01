/**
 * `useT()` — translation hook. Resolves message keys against the active
 * locale and substitutes `{name}` placeholders with the supplied args.
 *
 * Locale resolution order:
 *   1. settings.language from installedStore (when SettingsPage saves it)
 *   2. navigator.language (matches `ko*` → ko, otherwise en)
 *   3. 'en' fallback
 *
 * Returns a stable function across re-renders so component memos keep working.
 * Locale changes through Settings will trigger an explicit reload (Phase 2.5
 * adds live switching once we wire a settings:changed event).
 */
import { useCallback } from 'react';
import { messages, type LocaleCode, type MessageKey } from './messages';

let activeLocale: LocaleCode = (() => {
  if (typeof navigator !== 'undefined' && /^ko/i.test(navigator.language)) return 'ko';
  return 'en';
})();

export function setActiveLocale(loc: LocaleCode): void {
  activeLocale = loc;
}

export function getActiveLocale(): LocaleCode {
  return activeLocale;
}

export function t(key: MessageKey, args?: Record<string, string | number>): string {
  const m = messages[key];
  let s = m[activeLocale] ?? m.en;
  if (args) {
    for (const [k, v] of Object.entries(args)) {
      s = s.replace(`{${k}}`, String(v));
    }
  }
  return s;
}

export function useT() {
  return useCallback(t, []);
}
