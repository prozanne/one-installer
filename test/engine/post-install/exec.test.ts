import { describe, it, expect } from 'vitest';
import { execHandler } from '@main/engine/post-install/exec';
import { MockPlatform } from '@main/platform';
import { bufferSha256 } from '@main/packages/payload-hash';

const VALID_BIN = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);

describe('execHandler', () => {
  it('rejects exec when binary hash is not in allowedHashes', async () => {
    const p = new MockPlatform();
    await p.ensureDir('/Apps/X');
    await p.fs.promises.writeFile('/Apps/X/tool.exe', VALID_BIN);
    const ctx = {
      platform: p,
      templateContext: { installPath: '/Apps/X' },
      systemVars: p.systemVars(),
      installPath: '/Apps/X',
      appId: 'x',
      payloadDir: '/Apps/X',
    };
    await expect(
      execHandler.apply(
        {
          type: 'exec',
          cmd: '{{installPath}}/tool.exe',
          args: ['--ok'],
          timeoutSec: 5,
          allowedHashes: ['sha256:' + 'b'.repeat(64)],
        },
        ctx,
      ),
    ).rejects.toThrow(/hash/i);
  });

  it('runs exec when hash matches and exit code is 0', async () => {
    const p = new MockPlatform({
      execHandler: () => ({
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        durationMs: 5,
        timedOut: false,
      }),
    });
    await p.ensureDir('/Apps/X');
    await p.fs.promises.writeFile('/Apps/X/tool.exe', VALID_BIN);
    const hash = bufferSha256(VALID_BIN);
    const entry = await execHandler.apply(
      {
        type: 'exec',
        cmd: '{{installPath}}/tool.exe',
        args: ['--ok'],
        timeoutSec: 5,
        allowedHashes: ['sha256:' + hash],
      },
      {
        platform: p,
        templateContext: { installPath: '/Apps/X' },
        systemVars: p.systemVars(),
        installPath: '/Apps/X',
        appId: 'x',
        payloadDir: '/Apps/X',
      },
    );
    expect(entry.type).toBe('exec');
    if (entry.type === 'exec') expect(entry.exitCode).toBe(0);
  });

  it('throws when exec exits non-zero', async () => {
    const p = new MockPlatform({
      execHandler: () => ({
        exitCode: 2,
        stdout: '',
        stderr: 'fail',
        durationMs: 1,
        timedOut: false,
      }),
    });
    await p.ensureDir('/Apps/X');
    await p.fs.promises.writeFile('/Apps/X/tool.exe', VALID_BIN);
    const hash = bufferSha256(VALID_BIN);
    await expect(
      execHandler.apply(
        {
          type: 'exec',
          cmd: '{{installPath}}/tool.exe',
          args: [],
          timeoutSec: 5,
          allowedHashes: ['sha256:' + hash],
        },
        {
          platform: p,
          templateContext: { installPath: '/Apps/X' },
          systemVars: p.systemVars(),
          installPath: '/Apps/X',
          appId: 'x',
          payloadDir: '/Apps/X',
        },
      ),
    ).rejects.toThrow(/exit code 2/i);
  });
});
