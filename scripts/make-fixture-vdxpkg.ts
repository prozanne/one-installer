/**
 * Generate a sample .vdxpkg fixture for manual smoke testing.
 * Run: npm run gen:fixture
 * Output: dist/sample-app.vdxpkg
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeVdxpkg } from '../test/helpers/make-vdxpkg';
import type { Manifest } from '../src/shared/schema';

async function main() {
  const manifest: Omit<Manifest, 'payload'> = {
    schemaVersion: 1,
    id: 'com.samsung.vdx.smoke',
    name: { default: 'Smoke Test App', ko: '스모크 테스트 앱' },
    version: '1.0.0',
    publisher: 'Samsung',
    description: { default: 'A sample app for VDX Installer smoke testing.' },
    size: { download: 1024, installed: 4096 },
    minHostVersion: '0.1.0',
    targets: { os: 'win32', arch: ['x64'] },
    installScope: { supports: ['user'], default: 'user' },
    requiresReboot: false,
    license: { type: 'EULA', file: 'EULA.txt', required: true },
    wizard: [
      { type: 'license', id: 'eula', fileFromPayload: 'EULA.txt' },
      {
        type: 'path',
        id: 'installPath',
        label: { default: 'Install location', ko: '설치 위치' },
        default: 'C:/Users/u/AppData/Local/Programs/Samsung/Smoke',
      },
      {
        type: 'checkboxGroup',
        id: 'components',
        label: { default: 'Components', ko: '구성 요소' },
        items: [
          {
            id: 'core',
            label: { default: 'Core (required)' },
            default: true,
            required: true,
          },
          {
            id: 'samples',
            label: { default: 'Sample assets' },
            default: true,
            required: false,
          },
        ],
      },
      {
        type: 'select',
        id: 'shortcut',
        label: { default: 'Create shortcut' },
        options: [
          {
            value: 'desktop+menu',
            label: { default: 'Desktop + Start Menu' },
            default: true,
          },
          { value: 'menu', label: { default: 'Start Menu only' } },
          { value: 'none', label: { default: 'None' } },
        ],
      },
      {
        type: 'text',
        id: 'deviceName',
        label: { default: 'Device nickname (optional)' },
        default: '',
        optional: true,
      },
      { type: 'summary' },
    ],
    install: { extract: [{ from: '**/*', to: '{{installPath}}' }] },
    postInstall: [
      {
        type: 'shortcut',
        where: 'desktop',
        target: '{{installPath}}/smoke.exe',
        name: 'Smoke Test',
        when: "{{shortcut}} == 'desktop+menu'",
      },
      {
        type: 'shortcut',
        where: 'startMenu',
        target: '{{installPath}}/smoke.exe',
        name: 'Smoke Test',
        when: "{{shortcut}} != 'none'",
      },
      {
        type: 'registry',
        hive: 'HKCU',
        key: 'Software\\Samsung\\Smoke',
        values: {
          InstallPath: { type: 'REG_SZ', data: '{{installPath}}' },
          DeviceName: { type: 'REG_SZ', data: '{{deviceName}}' },
        },
      },
    ],
    uninstall: {
      removePaths: ['{{installPath}}'],
      removeRegistry: [{ hive: 'HKCU', key: 'Software\\Samsung\\Smoke' }],
      removeShortcuts: true,
      removeEnvPath: true,
    },
  };

  const { vdxpkgBytes } = await makeVdxpkg({
    manifest,
    payloadFiles: {
      'smoke.exe': Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]),
      'EULA.txt':
        'VDX Installer Smoke Test EULA\n\n' +
        'This is a sample EULA for smoke testing. It contains no actual legal terms.\n\n' +
        'By proceeding, you agree to test this installer.\n',
      'samples/readme.md': '# Sample assets\n\nPlaceholder for optional component.\n',
    },
  });

  const outDir = resolve('dist');
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, 'sample-app.vdxpkg');
  writeFileSync(outPath, vdxpkgBytes);
  console.log(`Wrote ${outPath} (${vdxpkgBytes.length} bytes)`);
  console.log('Drop this file into the VDX Installer window to smoke test.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
