import { describe, it, expect } from 'vitest';
import { shortcutHandler } from '@main/engine/post-install/shortcut';
import { MockPlatform } from '@main/platform';

describe('shortcutHandler', () => {
  it('creates a desktop shortcut and supports inverse', async () => {
    const p = new MockPlatform();
    const ctx = {
      platform: p,
      templateContext: { installPath: '/Apps/X' },
      systemVars: p.systemVars(),
      installPath: '/Apps/X',
      appId: 'com.samsung.vdx.x',
      payloadDir: '/payload',
    };
    const entry = await shortcutHandler.apply(
      { type: 'shortcut', where: 'desktop', target: '{{installPath}}/x.exe', name: 'X' },
      ctx,
    );
    expect(entry.type).toBe('shortcut');
    if (entry.type === 'shortcut') expect(p.shortcuts.has(entry.path)).toBe(true);

    await shortcutHandler.inverse(entry, p);
    if (entry.type === 'shortcut') expect(p.shortcuts.has(entry.path)).toBe(false);
  });
});
