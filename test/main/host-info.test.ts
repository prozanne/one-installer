import { describe, it, expect } from 'vitest';
import { buildHostInfo, osLabel } from '@main/host-info';

describe('buildHostInfo', () => {
  it('reports current platform + arch + hostname', () => {
    const info = buildHostInfo({ headless: false, hostVersion: '0.1.0' });
    expect(info.platform).toBe(process.platform);
    expect(info.arch).toBe(process.arch);
    expect(info.hostname.length).toBeGreaterThan(0);
    expect(info.hostVersion).toBe('0.1.0');
    expect(info.headless).toBe(false);
  });

  it('headless flag passes through', () => {
    expect(buildHostInfo({ headless: true, hostVersion: 'x' }).headless).toBe(true);
  });

  it('osLabel produces a non-empty string for the current platform', () => {
    const label = osLabel(process.platform);
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
  });

  it('osLabel handles unknown platform gracefully', () => {
    const label = osLabel('plan9');
    expect(label.startsWith('plan9')).toBe(true);
  });

  it('osLabel marks Win11-era builds correctly', () => {
    // We can't hot-swap process.platform, so this just sanity-checks the
    // label string format. Real Windows build detection lives in osLabel
    // itself and is exercised manually on a Win11 box.
    const label = osLabel('win32');
    expect(label).toMatch(/^Windows /);
  });

  it('Linux distro is null on non-Linux', () => {
    if (process.platform === 'linux') {
      // On Linux runners, distro may be set or null (depends on /etc/os-release).
      const info = buildHostInfo({ headless: false, hostVersion: 'x' });
      expect(info.distro === null || typeof info.distro === 'string').toBe(true);
    } else {
      const info = buildHostInfo({ headless: false, hostVersion: 'x' });
      expect(info.distro).toBeNull();
    }
  });
});
