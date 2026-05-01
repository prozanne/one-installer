/**
 * Auth IPC handler tests.
 *
 * Targets `src/main/ipc/handlers/auth.ts`. Inject fakes for safeStorage and
 * fs so the test never depends on Electron / OS keychain / disk. The
 * crucial assertion: the plaintext token never appears in the response.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleAuthSetToken, handleAuthClearToken } from '@main/ipc/handlers/auth';
import type {
  AuthHandlerDeps,
  SafeStorageLike,
  AuthFsLike,
} from '@main/ipc/handlers/auth';

const STORE = '/fake/auth.bin';

interface FakeDeps {
  deps: AuthHandlerDeps;
  safeStorage: {
    isEncryptionAvailable: ReturnType<typeof vi.fn>;
    encryptString: ReturnType<typeof vi.fn>;
  };
  fs: {
    writeFileSync: ReturnType<typeof vi.fn>;
    existsSync: ReturnType<typeof vi.fn>;
    unlinkSync: ReturnType<typeof vi.fn>;
  };
}

function makeDeps(overrides?: {
  safeStorage?: Partial<SafeStorageLike>;
  fs?: Partial<AuthFsLike>;
}): FakeDeps {
  const safeStorage = {
    isEncryptionAvailable: vi.fn().mockReturnValue(true),
    encryptString: vi.fn().mockReturnValue(Buffer.from('encrypted')),
  };
  if (overrides?.safeStorage?.isEncryptionAvailable) {
    safeStorage.isEncryptionAvailable = overrides.safeStorage.isEncryptionAvailable as unknown as typeof safeStorage.isEncryptionAvailable;
  }
  if (overrides?.safeStorage?.encryptString) {
    safeStorage.encryptString = overrides.safeStorage.encryptString as unknown as typeof safeStorage.encryptString;
  }
  const fs = {
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    unlinkSync: vi.fn(),
  };
  if (overrides?.fs?.writeFileSync) {
    fs.writeFileSync = overrides.fs.writeFileSync as unknown as typeof fs.writeFileSync;
  }
  if (overrides?.fs?.existsSync) {
    fs.existsSync = overrides.fs.existsSync as unknown as typeof fs.existsSync;
  }
  if (overrides?.fs?.unlinkSync) {
    fs.unlinkSync = overrides.fs.unlinkSync as unknown as typeof fs.unlinkSync;
  }
  return {
    deps: {
      authStorePath: STORE,
      safeStorage: safeStorage as unknown as SafeStorageLike,
      fs: fs as unknown as AuthFsLike,
    },
    safeStorage,
    fs,
  };
}

describe('handleAuthSetToken', () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('encrypts and writes when safeStorage is available', async () => {
    const res = await handleAuthSetToken(deps.deps, { token: 'ghp_secrettoken' });
    expect(res.ok).toBe(true);
    expect(deps.safeStorage.encryptString).toHaveBeenCalledWith('ghp_secrettoken');
    expect(deps.fs.writeFileSync).toHaveBeenCalledWith(
      STORE,
      Buffer.from('encrypted'),
      { mode: 0o600 },
    );
  });

  it('never echoes the token in the response', async () => {
    const res = await handleAuthSetToken(deps.deps, { token: 'ghp_supersecret' });
    expect(JSON.stringify(res)).not.toContain('ghp_supersecret');
  });

  it('fails closed when safeStorage is unavailable (no plaintext fallback)', async () => {
    deps = makeDeps({ safeStorage: { isEncryptionAvailable: vi.fn().mockReturnValue(false) } });
    const res = await handleAuthSetToken(deps.deps, { token: 'whatever' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/secure storage unavailable/i);
    expect(deps.fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('rejects empty / oversized tokens at the schema layer', async () => {
    expect((await handleAuthSetToken(deps.deps, { token: '' })).ok).toBe(false);
    expect((await handleAuthSetToken(deps.deps, { token: 'x'.repeat(257) })).ok).toBe(false);
    expect((await handleAuthSetToken(deps.deps, {})).ok).toBe(false);
  });

  it('surfaces fs write errors', async () => {
    deps = makeDeps({
      fs: {
        writeFileSync: vi.fn().mockImplementation(() => {
          throw new Error('disk full');
        }),
      },
    });
    const res = await handleAuthSetToken(deps.deps, { token: 'tok' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/disk full/);
  });
});

describe('handleAuthClearToken', () => {
  it('removes the file when present', async () => {
    const deps = makeDeps({ fs: { existsSync: vi.fn().mockReturnValue(true) } });
    const res = await handleAuthClearToken(deps.deps, {});
    expect(res.ok).toBe(true);
    expect(deps.fs.unlinkSync).toHaveBeenCalledWith(STORE);
  });

  it('is a no-op (still ok:true) when the file does not exist', async () => {
    const deps = makeDeps();
    const res = await handleAuthClearToken(deps.deps, {});
    expect(res.ok).toBe(true);
    expect(deps.fs.unlinkSync).not.toHaveBeenCalled();
  });

  it('accepts undefined raw payload', async () => {
    const deps = makeDeps();
    const res = await handleAuthClearToken(deps.deps, undefined);
    expect(res.ok).toBe(true);
  });
});
