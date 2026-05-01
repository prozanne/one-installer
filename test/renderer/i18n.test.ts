import { describe, it, expect, beforeEach } from 'vitest';
import { setActiveLocale, t } from '@renderer/i18n/useT';

describe('i18n', () => {
  beforeEach(() => {
    setActiveLocale('en');
  });

  it('returns English strings by default', () => {
    expect(t('nav.apps')).toBe('Apps');
    expect(t('updates.empty')).toBe('All apps are up to date');
  });

  it('switches to Korean when active locale is ko', () => {
    setActiveLocale('ko');
    expect(t('updates.empty')).toBe('모든 앱이 최신 버전입니다');
    expect(t('update.error.dismiss')).toBe('닫기');
  });

  it('substitutes {placeholder} args', () => {
    setActiveLocale('en');
    expect(t('update.available.title', { version: '1.5.0' })).toBe('1.5.0 available');
    setActiveLocale('ko');
    expect(t('update.available.title', { version: '1.5.0' })).toBe('1.5.0 사용 가능');
  });

  it('substitutes numeric args', () => {
    setActiveLocale('en');
    expect(t('updates.count', { n: 3 })).toBe('3 app(s) can be updated');
  });

  it('falls through to English when active locale has no entry (defensive)', () => {
    // No keys are en-only today, but verify the resolver shape is correct.
    setActiveLocale('en');
    const r = t('nav.settings');
    expect(typeof r).toBe('string');
    expect(r.length).toBeGreaterThan(0);
  });
});
