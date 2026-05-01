/**
 * Renderer-side i18n. Two locales (ko, en); falls back to the default
 * key when a translation is missing. Single static file because the
 * renderer's chunk budget already shrinks lazy chunks aggressively;
 * adding a fetch round-trip per locale isn't worth it for ~200 strings.
 *
 * Schema: a flat key→{ ko, en, default? } dict. The `default` is what a
 * resolver returns when the active locale has no entry — usually the
 * English string, since most engineers reading logs read English.
 */
export type LocaleCode = 'ko' | 'en';

export interface LocalizedMessage {
  ko: string;
  en: string;
}

export const messages = {
  // Sidebar nav
  'nav.apps': { ko: 'Apps', en: 'Apps' },
  'nav.agents': { ko: 'Agents', en: 'Agents' },
  'nav.updates': { ko: 'Updates', en: 'Updates' },
  'nav.settings': { ko: 'Settings', en: 'Settings' },

  // Update badge phases
  'update.available.title': {
    ko: '{version} 사용 가능',
    en: '{version} available',
  },
  'update.available.action': {
    ko: '클릭해서 다운로드',
    en: 'Click to download',
  },
  'update.downloading': { ko: '다운로드 중…', en: 'Downloading…' },
  'update.ready.title': { ko: '지금 재시작', en: 'Restart now' },
  'update.applying': { ko: '재시작 중…', en: 'Restarting…' },
  'update.error.title': { ko: '업데이트 실패', en: 'Update failed' },
  'update.error.dismiss': { ko: '닫기', en: 'Dismiss' },

  // Updates page
  'updates.title': { ko: 'Updates', en: 'Updates' },
  'updates.empty': {
    ko: '모든 앱이 최신 버전입니다',
    en: 'All apps are up to date',
  },
  'updates.count': { ko: '{n}개 앱이 업데이트 가능', en: '{n} app(s) can be updated' },
  'updates.refresh': { ko: 'Refresh', en: 'Refresh' },
  'updates.refreshing': { ko: 'Refreshing...', en: 'Refreshing...' },
  'updates.button': { ko: 'Update', en: 'Update' },
  'updates.button.busy': { ko: '준비 중...', en: 'Preparing...' },
  'updates.empty.detail': {
    ko: '업데이트 가능한 항목이 없습니다. 카탈로그가 갱신되면 여기 자동으로 표시됩니다.',
    en: 'No updates available. New versions appear here automatically when the catalog refreshes.',
  },

  // Wizard
  'wizard.cancel': { ko: 'Cancel', en: 'Cancel' },
  'wizard.back': { ko: 'Back', en: 'Back' },
  'wizard.next': { ko: 'Next', en: 'Next' },
  'wizard.install': { ko: 'Install', en: 'Install' },
  'wizard.untrusted_publisher': {
    ko: '⚠ 신뢰되지 않은 게시자 (개발자 모드)',
    en: '⚠ Untrusted publisher (developer mode)',
  },

  // Sideload / catalog
  'home.installed_title': { ko: 'Installed apps', en: 'Installed apps' },
  'home.openpkg': { ko: 'Open package...', en: 'Open package...' },
  'home.dropzone': { ko: '.vdxpkg 파일을 여기로 드래그', en: 'Drop a .vdxpkg here' },
  'home.dropzone_hint': {
    ko: '또는 "Open package..." 클릭으로 파일 선택',
    en: 'or click "Open package..." to pick a file',
  },
} satisfies Record<string, LocalizedMessage>;

export type MessageKey = keyof typeof messages;
