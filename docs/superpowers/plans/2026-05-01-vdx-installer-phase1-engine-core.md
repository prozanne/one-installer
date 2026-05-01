# VDX Installer — Phase 1.0: Engine Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the cross-platform engine core of the VDX Installer — manifest schema, template/when engine, wizard logic, transactional install/uninstall with journal-based rollback, sideload package parsing, and Ed25519 signature verification — fully testable on macOS via memfs and mock platform.

**Architecture:** Pure TypeScript, no Electron yet. Platform-specific operations (registry, shortcuts, PATH, ARP) go through a `Platform` interface so we can use a mock impl in tests on macOS and a real Windows impl later. yauzl/yazl for zip, zod for schemas, @noble/ed25519 for signatures, memfs for tests.

**Tech Stack:** TypeScript 5.x · vitest · zod · yauzl · yazl · @noble/ed25519 · memfs · pnpm

**Scope:**
- IN: All engine modules per spec §15.2 `src/main/engine/` + `src/shared/` + `src/main/state/` + sideload parsing.
- OUT (later phases): Electron host, React UI, IPC, network/catalog, self-update, code signing pipeline, elevated worker, i18n.

**Companion docs:**
- `docs/superpowers/specs/2026-05-01-vdx-installer-design.md`
- `docs/superpowers/specs/2026-05-01-vdx-installer-flows.md`
- `docs/superpowers/specs/2026-05-01-vdx-installer-data-model.md`

**Test plan:** see `docs/superpowers/plans/2026-05-01-vdx-installer-test-plan.md`.

---

## File Structure

```
vdx-installer/
├─ package.json
├─ pnpm-workspace.yaml
├─ tsconfig.json
├─ tsconfig.build.json
├─ vitest.config.ts
├─ .eslintrc.cjs
├─ .prettierrc
├─ .gitignore
├─ src/
│  ├─ shared/
│  │  ├─ schema/
│  │  │  ├─ manifest.ts            zod manifest v1
│  │  │  ├─ catalog.ts             zod catalog v1
│  │  │  ├─ installed-state.ts     zod installed.json v1
│  │  │  ├─ journal.ts             zod journal step v1
│  │  │  ├─ ipc.ts                 zod IPC contracts (placeholder for phase 2)
│  │  │  └─ index.ts               re-exports
│  │  ├─ types/
│  │  │  ├─ wizard-answer.ts       AnswerValue union
│  │  │  ├─ result.ts              Result<T, E> helper
│  │  │  └─ index.ts
│  │  └─ constants.ts              SCHEMA_VERSION, etc.
│  ├─ main/
│  │  ├─ platform/
│  │  │  ├─ types.ts               Platform interface
│  │  │  ├─ mock.ts                In-memory mock impl for tests
│  │  │  ├─ windows.ts             Real Windows impl (stubs in phase 1.0; impl in phase 1.1)
│  │  │  ├─ system-paths.ts        Resolve {ProgramFiles}, {LocalAppData}, etc.
│  │  │  └─ index.ts
│  │  ├─ engine/
│  │  │  ├─ template.ts            {{var}} resolver
│  │  │  ├─ when-expr.ts           when expression parser+evaluator
│  │  │  ├─ wizard.ts              step iteration, validation, answer reuse diff
│  │  │  ├─ install.ts             extract orchestrator
│  │  │  ├─ uninstall.ts
│  │  │  ├─ transaction.ts         journal + rollback
│  │  │  ├─ post-install/
│  │  │  │  ├─ types.ts            Action handler interface
│  │  │  │  ├─ shortcut.ts
│  │  │  │  ├─ registry.ts
│  │  │  │  ├─ env-path.ts
│  │  │  │  ├─ exec.ts
│  │  │  │  ├─ arp.ts              implicit
│  │  │  │  └─ index.ts            dispatcher
│  │  │  └─ validate.ts            static manifest checks
│  │  ├─ packages/
│  │  │  ├─ zip-safe.ts            yauzl wrapper with zip-slip / symlink guards
│  │  │  ├─ vdxpkg.ts              .vdxpkg parsing
│  │  │  ├─ signature.ts           Ed25519 verify
│  │  │  └─ payload-hash.ts        sha256 streaming
│  │  ├─ state/
│  │  │  ├─ installed-store.ts     read/write installed.json atomic
│  │  │  ├─ atomic-write.ts        tmp+rename pattern
│  │  │  ├─ lock.ts                per-app lockfile
│  │  │  └─ paths.ts               %APPDATA% layout helpers (mockable)
│  │  ├─ logging/
│  │  │  ├─ logger.ts              minimal pino-style logger interface
│  │  │  └─ redact.ts              sensitive-field redaction
│  │  └─ index.ts                  Engine façade for phase 2 IPC layer
└─ test/
   ├─ fixtures/
   │  ├─ keys/
   │  │  ├─ dev-pub.bin
   │  │  └─ dev-priv.bin            (gitignored after generation)
   │  ├─ manifests/
   │  │  ├─ minimal.json
   │  │  ├─ full.json
   │  │  └─ invalid-*.json
   │  └─ payloads/
   │     ├─ minimal/                source files we zip in tests
   │     └─ full/
   ├─ helpers/
   │  ├─ make-vdxpkg.ts             produce a test .vdxpkg from fixture dir
   │  ├─ mem-platform.ts            convenience wrapper around mock platform
   │  └─ key-fixtures.ts            dev key pair loader
   └─ engine/
      ├─ template.test.ts
      ├─ when-expr.test.ts
      ├─ wizard.test.ts
      ├─ install.test.ts
      ├─ post-install/
      │  ├─ shortcut.test.ts
      │  ├─ registry.test.ts
      │  ├─ env-path.test.ts
      │  └─ exec.test.ts
      ├─ transaction.test.ts
      ├─ uninstall.test.ts
      ├─ validate.test.ts
      ├─ vdxpkg.test.ts
      ├─ signature.test.ts
      └─ installed-store.test.ts
```

---

## Phase A — Project scaffold (Tasks 1-5)

### Task 1: Initialize package + tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `pnpm-workspace.yaml`, `.gitignore`, `.editorconfig`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "vdx-installer",
  "version": "0.1.0",
  "private": true,
  "description": "Samsung VDX Installer — Electron one-installer for VDX apps",
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint . --ext .ts,.tsx",
    "format": "prettier --write \"src/**/*.{ts,tsx,json}\" \"test/**/*.{ts,tsx,json}\"",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  },
  "devDependencies": {
    "@types/node": "^20.12.0",
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "@typescript-eslint/parser": "^7.0.0",
    "@vitest/coverage-v8": "^1.5.0",
    "eslint": "^8.57.0",
    "memfs": "^4.9.0",
    "prettier": "^3.2.0",
    "typescript": "^5.4.0",
    "vitest": "^1.5.0"
  },
  "dependencies": {
    "@noble/ed25519": "^2.1.0",
    "yauzl": "^3.1.0",
    "yazl": "^2.5.1",
    "zod": "^3.23.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "lib": ["ES2022"],
    "types": ["node", "vitest/globals"],
    "baseUrl": "src",
    "paths": {
      "@shared/*": ["shared/*"],
      "@main/*": ["main/*"]
    }
  },
  "include": ["src/**/*", "test/**/*", "vitest.config.ts"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```gitignore
node_modules/
dist/
coverage/
*.log
.DS_Store
.vscode/
test/fixtures/keys/dev-priv.bin
test/fixtures/keys/dev-pub.bin
*.tsbuildinfo
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/index.ts'],
    },
  },
  resolve: {
    alias: {
      '@shared': '/src/shared',
      '@main': '/src/main',
    },
  },
});
```

- [ ] **Step 5: Run `pnpm install`**

Run: `pnpm install`
Expected: dependencies installed, `pnpm-lock.yaml` created.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts .gitignore
git commit -m "chore: initialize package, TypeScript, vitest tooling"
```

---

### Task 2: ESLint + Prettier config

**Files:**
- Create: `.eslintrc.cjs`, `.prettierrc`, `.eslintignore`

- [ ] **Step 1: `.eslintrc.cjs`**

```js
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { project: './tsconfig.json', sourceType: 'module', ecmaVersion: 2022 },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/consistent-type-imports': 'error',
    '@typescript-eslint/no-explicit-any': 'error',
  },
};
```

- [ ] **Step 2: `.prettierrc`**

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

- [ ] **Step 3: `.eslintignore`**

```
node_modules
dist
coverage
test/fixtures/payloads
```

- [ ] **Step 4: Verify**

Run: `pnpm lint` and `pnpm typecheck`
Expected: both succeed (no source files yet, but configs are valid).

- [ ] **Step 5: Commit**

```bash
git add .eslintrc.cjs .prettierrc .eslintignore
git commit -m "chore: add eslint + prettier"
```

---

## Phase B — Shared types & schemas (Tasks 3-9)

### Task 3: Constants + Result helper

**Files:**
- Create: `src/shared/constants.ts`, `src/shared/types/result.ts`, `src/shared/types/index.ts`

- [ ] **Step 1: Test for Result type**

Create `test/shared/result.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ok, err, isOk, isErr, type Result } from '@shared/types';

describe('Result', () => {
  it('ok wraps value', () => {
    const r: Result<number, string> = ok(42);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toBe(42);
  });

  it('err wraps error', () => {
    const r: Result<number, string> = err('boom');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error).toBe('boom');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

`pnpm test test/shared/result.test.ts`
Expected: cannot find module.

- [ ] **Step 3: Implement `src/shared/types/result.ts`**

```ts
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok;
```

- [ ] **Step 4: `src/shared/types/index.ts`**

```ts
export * from './result';
export * from './wizard-answer';
```

- [ ] **Step 5: `src/shared/types/wizard-answer.ts`**

```ts
export type AnswerValue = string | boolean | Record<string, boolean>;
export type WizardAnswers = Record<string, AnswerValue>;
```

- [ ] **Step 6: `src/shared/constants.ts`**

```ts
export const MANIFEST_SCHEMA_VERSION = 1 as const;
export const CATALOG_SCHEMA_VERSION = 1 as const;
export const INSTALLED_STATE_SCHEMA_VERSION = 1 as const;

export const APP_ID_REGEX = /^[a-z][a-z0-9-]{0,30}(\.[a-z][a-z0-9-]{0,30}){2,5}$/;
export const SEMVER_REGEX = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/;

export const TX_TIMEOUT_MS_DEFAULT = 30_000;
export const EXEC_TIMEOUT_MS_MAX = 300_000;
```

- [ ] **Step 7: Run test**

`pnpm test test/shared/result.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/shared test/shared
git commit -m "feat(shared): add Result helper and constants"
```

---

### Task 4: zod manifest schema

**Files:**
- Create: `src/shared/schema/manifest.ts`, `test/shared/schema/manifest.test.ts`
- Modify: `src/shared/schema/index.ts`

- [ ] **Step 1: Tests** — covers all wizard step types and post-install action types from spec §3

Create `test/shared/schema/manifest.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ManifestSchema } from '@shared/schema/manifest';

const minimal = {
  schemaVersion: 1,
  id: 'com.samsung.vdx.example',
  name: { default: 'Example' },
  version: '1.0.0',
  publisher: 'Samsung',
  description: { default: 'desc' },
  payload: { filename: 'payload.zip', sha256: 'a'.repeat(64), compressedSize: 100 },
  size: { download: 100, installed: 200 },
  minHostVersion: '1.0.0',
  targets: { os: 'win32' as const, arch: ['x64' as const] },
  installScope: { supports: ['user' as const], default: 'user' as const },
  requiresReboot: false,
  wizard: [{ type: 'summary' as const }],
  install: { extract: [{ from: '**/*', to: '{{installPath}}' }] },
  postInstall: [],
  uninstall: { removePaths: ['{{installPath}}'], removeShortcuts: true },
};

describe('ManifestSchema', () => {
  it('accepts a minimal valid manifest', () => {
    const parsed = ManifestSchema.parse(minimal);
    expect(parsed.id).toBe('com.samsung.vdx.example');
  });

  it('rejects bad id format', () => {
    expect(() => ManifestSchema.parse({ ...minimal, id: 'BadID' })).toThrow();
  });

  it('rejects bad version', () => {
    expect(() => ManifestSchema.parse({ ...minimal, version: 'v1' })).toThrow();
  });

  it('accepts all wizard step types', () => {
    const m = {
      ...minimal,
      wizard: [
        { type: 'license', id: 'eula', fileFromPayload: 'EULA.txt' },
        { type: 'path', id: 'installPath', label: { default: 'Path' }, default: '{ProgramFiles}/X' },
        {
          type: 'checkboxGroup',
          id: 'comp',
          label: { default: 'Components' },
          items: [{ id: 'core', label: { default: 'Core' }, default: true, required: true }],
        },
        {
          type: 'select',
          id: 'sc',
          label: { default: 'Shortcut' },
          options: [{ value: 'menu', label: { default: 'Menu' }, default: true }],
        },
        { type: 'text', id: 'name', label: { default: 'Name' }, default: '', optional: true },
        { type: 'summary' },
      ],
    };
    expect(() => ManifestSchema.parse(m)).not.toThrow();
  });

  it('accepts all postInstall action types', () => {
    const m = {
      ...minimal,
      postInstall: [
        { type: 'shortcut', where: 'desktop', target: '{{installPath}}/x.exe', name: 'X' },
        { type: 'registry', hive: 'HKCU', key: 'Software\\X', values: { K: { type: 'REG_SZ', data: 'v' } } },
        { type: 'envPath', scope: 'user', add: '{{installPath}}/bin' },
        {
          type: 'exec',
          cmd: '{{installPath}}/x.exe',
          args: ['--silent'],
          timeoutSec: 30,
          allowedHashes: ['sha256:' + 'b'.repeat(64)],
        },
      ],
    };
    expect(() => ManifestSchema.parse(m)).not.toThrow();
  });

  it('rejects exec without allowedHashes', () => {
    const m = {
      ...minimal,
      postInstall: [{ type: 'exec', cmd: '{{installPath}}/x.exe', args: [], timeoutSec: 30, allowedHashes: [] }],
    };
    expect(() => ManifestSchema.parse(m)).toThrow();
  });

  it('rejects exec with timeout above max', () => {
    const m = {
      ...minimal,
      postInstall: [
        { type: 'exec', cmd: 'x', args: [], timeoutSec: 9999, allowedHashes: ['sha256:' + 'b'.repeat(64)] },
      ],
    };
    expect(() => ManifestSchema.parse(m)).toThrow();
  });
});
```

- [ ] **Step 2: Run — FAIL**

`pnpm test test/shared/schema/manifest.test.ts`
Expected: cannot find module.

- [ ] **Step 3: Implement `src/shared/schema/manifest.ts`**

```ts
import { z } from 'zod';
import { APP_ID_REGEX, EXEC_TIMEOUT_MS_MAX, SEMVER_REGEX } from '../constants';

const Localized = z.object({ default: z.string() }).catchall(z.string());
const Sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const LicenseStep = z.object({
  type: z.literal('license'),
  id: z.string().min(1),
  fileFromPayload: z.string().optional(),
  text: Localized.optional(),
});

const PathStep = z.object({
  type: z.literal('path'),
  id: z.string().min(1),
  label: Localized,
  default: z.string(),
  validate: z.array(z.string()).optional(),
});

const CheckboxItem = z.object({
  id: z.string(),
  label: Localized,
  default: z.boolean().default(false),
  required: z.boolean().default(false),
});

const CheckboxGroupStep = z.object({
  type: z.literal('checkboxGroup'),
  id: z.string().min(1),
  label: Localized,
  items: z.array(CheckboxItem).min(1),
});

const SelectOption = z.object({
  value: z.string(),
  label: Localized,
  default: z.boolean().optional(),
});

const SelectStep = z.object({
  type: z.literal('select'),
  id: z.string().min(1),
  label: Localized,
  options: z.array(SelectOption).min(1),
});

const TextStep = z.object({
  type: z.literal('text'),
  id: z.string().min(1),
  label: Localized,
  default: z.string().default(''),
  regex: z.string().optional(),
  optional: z.boolean().default(false),
});

const SummaryStep = z.object({ type: z.literal('summary') });

export const WizardStep = z.discriminatedUnion('type', [
  LicenseStep,
  PathStep,
  CheckboxGroupStep,
  SelectStep,
  TextStep,
  SummaryStep,
]);

const ShortcutAction = z.object({
  type: z.literal('shortcut'),
  where: z.enum(['desktop', 'startMenu', 'programs']),
  target: z.string(),
  name: z.string(),
  args: z.string().optional(),
  when: z.string().optional(),
});

const RegistryValue = z.object({
  type: z.enum(['REG_SZ', 'REG_DWORD', 'REG_QWORD', 'REG_EXPAND_SZ', 'REG_MULTI_SZ', 'REG_BINARY']),
  data: z.union([z.string(), z.number(), z.array(z.string())]),
});

const RegistryAction = z.object({
  type: z.literal('registry'),
  hive: z.enum(['HKCU', 'HKLM']),
  key: z.string(),
  values: z.record(z.string(), RegistryValue),
  when: z.string().optional(),
});

const EnvPathAction = z.object({
  type: z.literal('envPath'),
  scope: z.enum(['user', 'machine']),
  add: z.string(),
  when: z.string().optional(),
});

const ExecAction = z.object({
  type: z.literal('exec'),
  cmd: z.string(),
  args: z.array(z.string()),
  timeoutSec: z.number().int().positive().max(EXEC_TIMEOUT_MS_MAX / 1000),
  allowedHashes: z.array(Sha256).min(1),
  when: z.string().optional(),
});

export const PostInstallAction = z.discriminatedUnion('type', [
  ShortcutAction,
  RegistryAction,
  EnvPathAction,
  ExecAction,
]);

const ExtractRule = z.object({
  from: z.string(),
  to: z.string(),
  when: z.string().optional(),
});

export const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(APP_ID_REGEX),
  name: Localized,
  version: z.string().regex(SEMVER_REGEX),
  publisher: z.string().min(1),
  description: Localized,
  icon: z.string().optional(),
  screenshots: z.array(z.string()).max(4).optional(),
  homepage: z.string().url().optional(),
  supportUrl: z.string().url().optional(),
  license: z
    .object({
      type: z.enum(['EULA', 'OSS', 'Custom']),
      file: z.string().optional(),
      required: z.boolean(),
    })
    .optional(),
  size: z.object({ download: z.number().int().nonnegative(), installed: z.number().int().nonnegative() }),
  payload: z.object({
    filename: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    compressedSize: z.number().int().positive(),
  }),
  minHostVersion: z.string().regex(SEMVER_REGEX),
  targets: z.object({
    os: z.literal('win32'),
    arch: z.array(z.enum(['x64', 'arm64'])).min(1),
    minOsBuild: z.number().int().positive().optional(),
  }),
  installScope: z.object({
    supports: z.array(z.enum(['user', 'machine'])).min(1),
    default: z.enum(['user', 'machine']),
  }),
  requiresReboot: z.boolean(),
  wizard: z.array(WizardStep).min(1).refine(
    (steps) => steps[steps.length - 1]?.type === 'summary',
    { message: 'Last wizard step must be of type summary' },
  ),
  install: z.object({ extract: z.array(ExtractRule).min(1) }),
  postInstall: z.array(PostInstallAction),
  uninstall: z.object({
    removePaths: z.array(z.string()),
    removeRegistry: z
      .array(z.object({ hive: z.enum(['HKCU', 'HKLM']), key: z.string() }))
      .optional(),
    removeShortcuts: z.boolean().default(true),
    removeEnvPath: z.boolean().default(true),
    preExec: z.array(ExecAction).optional(),
  }),
});

export type Manifest = z.infer<typeof ManifestSchema>;
export type WizardStepT = z.infer<typeof WizardStep>;
export type PostInstallActionT = z.infer<typeof PostInstallAction>;
```

- [ ] **Step 4: `src/shared/schema/index.ts`**

```ts
export * from './manifest';
```

- [ ] **Step 5: Run tests**

`pnpm test test/shared/schema/manifest.test.ts`
Expected: 7/7 PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/schema test/shared/schema
git commit -m "feat(schema): zod manifest v1 schema with all wizard + action types"
```

---

### Task 5: zod installed-state + journal + catalog schemas

**Files:**
- Create: `src/shared/schema/installed-state.ts`, `src/shared/schema/journal.ts`, `src/shared/schema/catalog.ts`, `test/shared/schema/installed-state.test.ts`
- Modify: `src/shared/schema/index.ts`

- [ ] **Step 1: Test installed-state**

`test/shared/schema/installed-state.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { InstalledStateSchema } from '@shared/schema/installed-state';

describe('InstalledStateSchema', () => {
  it('accepts empty', () => {
    const s = {
      schema: 1,
      host: { version: '1.0.0' },
      lastCatalogSync: null,
      settings: {
        language: 'en',
        updateChannel: 'stable',
        autoUpdateHost: 'ask',
        autoUpdateApps: 'ask',
        cacheLimitGb: 5,
        proxy: null,
        telemetry: false,
        trayMode: false,
        developerMode: false,
      },
      apps: {},
    };
    expect(() => InstalledStateSchema.parse(s)).not.toThrow();
  });

  it('rejects bad schema version', () => {
    expect(() => InstalledStateSchema.parse({ schema: 99 })).toThrow();
  });
});
```

- [ ] **Step 2: Implement `src/shared/schema/journal.ts`**

```ts
import { z } from 'zod';

export const JournalEntry = z.discriminatedUnion('type', [
  z.object({ type: z.literal('extract'), files: z.array(z.string()), atTs: z.string().datetime() }),
  z.object({
    type: z.literal('shortcut'),
    path: z.string(),
    atTs: z.string().datetime(),
  }),
  z.object({
    type: z.literal('registry'),
    hive: z.enum(['HKCU', 'HKLM']),
    key: z.string(),
    createdValues: z.array(z.string()),
    overwroteValues: z.record(z.string(), z.unknown()).optional(),
    keyCreated: z.boolean(),
    atTs: z.string().datetime(),
  }),
  z.object({
    type: z.literal('envPath'),
    scope: z.enum(['user', 'machine']),
    added: z.string(),
    atTs: z.string().datetime(),
  }),
  z.object({
    type: z.literal('exec'),
    cmd: z.string(),
    exitCode: z.number().int(),
    atTs: z.string().datetime(),
  }),
  z.object({
    type: z.literal('arp'),
    hive: z.enum(['HKCU', 'HKLM']),
    appId: z.string(),
    atTs: z.string().datetime(),
  }),
]);

export type JournalEntryT = z.infer<typeof JournalEntry>;

export const TransactionStatus = z.enum([
  'pending',
  'extracting',
  'running-actions',
  'sealing',
  'committed',
  'rolled-back',
  'abandoned',
]);

export const TransactionFile = z.object({
  txid: z.string().uuid(),
  appId: z.string(),
  version: z.string(),
  scope: z.enum(['user', 'machine']),
  status: TransactionStatus,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  steps: z.array(JournalEntry),
});

export type TransactionFileT = z.infer<typeof TransactionFile>;
```

- [ ] **Step 3: Implement `src/shared/schema/installed-state.ts`**

```ts
import { z } from 'zod';
import { JournalEntry } from './journal';
import { ManifestSchema } from './manifest';

const Settings = z.object({
  language: z.string(),
  updateChannel: z.enum(['stable', 'beta', 'internal']),
  autoUpdateHost: z.enum(['auto', 'ask', 'manual']),
  autoUpdateApps: z.enum(['auto', 'ask', 'manual']),
  cacheLimitGb: z.number().int().positive(),
  proxy: z
    .object({ host: z.string(), port: z.number().int(), auth: z.string().nullable() })
    .nullable(),
  telemetry: z.boolean(),
  trayMode: z.boolean(),
  developerMode: z.boolean(),
});

const InstalledApp = z.object({
  version: z.string(),
  installScope: z.enum(['user', 'machine']),
  installPath: z.string(),
  wizardAnswers: z.record(z.string(), z.unknown()),
  journal: z.array(JournalEntry),
  manifestSnapshot: ManifestSchema,
  installedAt: z.string().datetime(),
  updateChannel: z.enum(['stable', 'beta', 'internal']),
  autoUpdate: z.enum(['auto', 'ask', 'manual']),
  source: z.enum(['catalog', 'sideload']).default('catalog'),
});

export const InstalledStateSchema = z.object({
  schema: z.literal(1),
  host: z.object({ version: z.string() }),
  lastCatalogSync: z.string().datetime().nullable(),
  settings: Settings,
  apps: z.record(z.string(), InstalledApp),
});

export type InstalledStateT = z.infer<typeof InstalledStateSchema>;
export type InstalledAppT = z.infer<typeof InstalledApp>;
export type SettingsT = z.infer<typeof Settings>;
```

- [ ] **Step 4: Implement `src/shared/schema/catalog.ts`**

```ts
import { z } from 'zod';

const Localized = z.object({ default: z.string() }).catchall(z.string());

export const CatalogSchema = z.object({
  schemaVersion: z.literal(1),
  updatedAt: z.string().datetime(),
  channels: z.array(z.enum(['stable', 'beta', 'internal'])),
  categories: z.array(z.object({ id: z.string(), label: Localized })),
  featured: z.array(z.string()),
  apps: z.array(
    z.object({
      id: z.string(),
      repo: z.string(),
      category: z.string(),
      channels: z.array(z.enum(['stable', 'beta', 'internal'])).min(1),
      tags: z.array(z.string()),
      minHostVersion: z.string(),
      deprecated: z.boolean(),
      replacedBy: z.string().nullable(),
      addedAt: z.string().datetime(),
    }),
  ),
});

export type CatalogT = z.infer<typeof CatalogSchema>;
```

- [ ] **Step 5: Update `src/shared/schema/index.ts`**

```ts
export * from './manifest';
export * from './installed-state';
export * from './journal';
export * from './catalog';
```

- [ ] **Step 6: Run tests**

`pnpm test test/shared/schema/`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/schema test/shared/schema
git commit -m "feat(schema): installed-state, journal, catalog schemas"
```

---

## Phase C — Template engine (Tasks 6-8)

### Task 6: Template variable resolver `{{var}}` + system vars

**Files:**
- Create: `src/main/engine/template.ts`, `test/engine/template.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'vitest';
import { renderTemplate, resolveVariables } from '@main/engine/template';

const sysVars = {
  ProgramFiles: 'C:/Program Files',
  LocalAppData: 'C:/Users/u/AppData/Local',
};

describe('renderTemplate', () => {
  it('substitutes simple var', () => {
    const ctx = { installPath: 'C:/X' };
    expect(renderTemplate('{{installPath}}/bin', ctx)).toBe('C:/X/bin');
  });

  it('substitutes nested', () => {
    const ctx = { components: { core: true, samples: false } };
    expect(renderTemplate('{{components.core}}', ctx)).toBe('true');
  });

  it('substitutes system vars', () => {
    expect(renderTemplate('{ProgramFiles}/X', {}, sysVars)).toBe('C:/Program Files/X');
  });

  it('throws on undefined variable', () => {
    expect(() => renderTemplate('{{missing}}', {})).toThrow();
  });

  it('handles multiple substitutions', () => {
    expect(renderTemplate('{ProgramFiles}/{{name}}/bin', { name: 'X' }, sysVars))
      .toBe('C:/Program Files/X/bin');
  });
});

describe('resolveVariables', () => {
  it('returns map of all referenced names', () => {
    const ref = resolveVariables('{ProgramFiles}/{{name}}/{{components.core}}');
    expect(ref.systemVars).toEqual(['ProgramFiles']);
    expect(ref.userVars).toEqual(['name', 'components.core']);
  });
});
```

- [ ] **Step 2: Implement `src/main/engine/template.ts`**

```ts
const USER_VAR_RE = /\{\{([a-zA-Z_][a-zA-Z0-9_.]*)\}\}/g;
const SYS_VAR_RE = /\{([A-Z][a-zA-Z0-9]*)\}/g;

export type SystemVars = Record<string, string>;
export type Context = Record<string, unknown>;

const get = (obj: Context, path: string): unknown => {
  return path.split('.').reduce<unknown>((acc, k) => {
    if (acc && typeof acc === 'object' && k in acc) return (acc as Record<string, unknown>)[k];
    return undefined;
  }, obj);
};

export function renderTemplate(input: string, ctx: Context, sysVars: SystemVars = {}): string {
  let result = input.replace(USER_VAR_RE, (_, key: string) => {
    const value = get(ctx, key);
    if (value === undefined) throw new Error(`Template variable not defined: {{${key}}}`);
    return String(value);
  });
  result = result.replace(SYS_VAR_RE, (_, key: string) => {
    if (!(key in sysVars)) throw new Error(`System variable not defined: {${key}}`);
    return sysVars[key]!;
  });
  return result;
}

export function resolveVariables(input: string): { userVars: string[]; systemVars: string[] } {
  const userVars = new Set<string>();
  const systemVars = new Set<string>();
  for (const m of input.matchAll(USER_VAR_RE)) userVars.add(m[1]!);
  for (const m of input.matchAll(SYS_VAR_RE)) systemVars.add(m[1]!);
  return { userVars: [...userVars], systemVars: [...systemVars] };
}
```

- [ ] **Step 3: Run** — `pnpm test test/engine/template.test.ts` → all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/engine/template.ts test/engine/template.test.ts
git commit -m "feat(engine): template variable resolver with user + system vars"
```

---

### Task 7: `when` expression parser & evaluator

**Files:**
- Create: `src/main/engine/when-expr.ts`, `test/engine/when-expr.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'vitest';
import { evaluateWhen, parseWhen } from '@main/engine/when-expr';

const ctx = {
  components: { core: true, samples: false, vstPath: true },
  shortcut: 'desktop+menu',
};

describe('parseWhen + evaluateWhen', () => {
  it('evaluates a single var', () => {
    expect(evaluateWhen('{{components.core}}', ctx)).toBe(true);
    expect(evaluateWhen('{{components.samples}}', ctx)).toBe(false);
  });

  it('evaluates equality', () => {
    expect(evaluateWhen("{{shortcut}} == 'desktop+menu'", ctx)).toBe(true);
    expect(evaluateWhen("{{shortcut}} == 'none'", ctx)).toBe(false);
  });

  it('evaluates inequality', () => {
    expect(evaluateWhen("{{shortcut}} != 'none'", ctx)).toBe(true);
  });

  it('evaluates && and ||', () => {
    expect(evaluateWhen('{{components.core}} && {{components.samples}}', ctx)).toBe(false);
    expect(evaluateWhen('{{components.core}} || {{components.samples}}', ctx)).toBe(true);
  });

  it('evaluates !', () => {
    expect(evaluateWhen('!{{components.samples}}', ctx)).toBe(true);
  });

  it('evaluates parens', () => {
    expect(
      evaluateWhen("({{components.core}} || {{components.samples}}) && {{shortcut}} == 'desktop+menu'", ctx),
    ).toBe(true);
  });

  it('rejects forbidden syntax', () => {
    expect(() => parseWhen('process.exit()')).toThrow();
    expect(() => parseWhen('{{x}} + 1')).toThrow();
    expect(() => parseWhen('{{x}}; {{y}}')).toThrow();
  });

  it('returns true for empty when (treat as always true)', () => {
    expect(evaluateWhen(undefined, ctx)).toBe(true);
    expect(evaluateWhen('', ctx)).toBe(true);
  });
});
```

- [ ] **Step 2: Implement `src/main/engine/when-expr.ts`**

Hand-written tokenizer + recursive-descent parser. Allowed tokens only:
identifier (`{{...}}`), string-literal (single quotes), `==`, `!=`, `&&`, `||`, `!`, `(`, `)`, `true`, `false`.

```ts
import { renderTemplate, type Context } from './template';

type Token =
  | { kind: 'var'; path: string }
  | { kind: 'str'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'op'; value: '==' | '!=' | '&&' | '||' | '!' | '(' | ')' };

const VAR_RE = /^\{\{([a-zA-Z_][a-zA-Z0-9_.]*)\}\}/;
const STR_RE = /^'([^']*)'/;

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(' || c === ')') {
      tokens.push({ kind: 'op', value: c });
      i++;
      continue;
    }
    if (c === '!' && input[i + 1] === '=') {
      tokens.push({ kind: 'op', value: '!=' });
      i += 2;
      continue;
    }
    if (c === '!') {
      tokens.push({ kind: 'op', value: '!' });
      i++;
      continue;
    }
    if (c === '=' && input[i + 1] === '=') {
      tokens.push({ kind: 'op', value: '==' });
      i += 2;
      continue;
    }
    if (c === '&' && input[i + 1] === '&') {
      tokens.push({ kind: 'op', value: '&&' });
      i += 2;
      continue;
    }
    if (c === '|' && input[i + 1] === '|') {
      tokens.push({ kind: 'op', value: '||' });
      i += 2;
      continue;
    }
    const rest = input.slice(i);
    const v = VAR_RE.exec(rest);
    if (v) {
      tokens.push({ kind: 'var', path: v[1]! });
      i += v[0].length;
      continue;
    }
    const s = STR_RE.exec(rest);
    if (s) {
      tokens.push({ kind: 'str', value: s[1]! });
      i += s[0].length;
      continue;
    }
    if (rest.startsWith('true')) {
      tokens.push({ kind: 'bool', value: true });
      i += 4;
      continue;
    }
    if (rest.startsWith('false')) {
      tokens.push({ kind: 'bool', value: false });
      i += 5;
      continue;
    }
    throw new Error(`when-expr: unexpected token at position ${i} ('${rest.slice(0, 8)}...')`);
  }
  return tokens;
}

type Ast =
  | { kind: 'var'; path: string }
  | { kind: 'lit'; value: string | boolean }
  | { kind: 'not'; rhs: Ast }
  | { kind: 'eq' | 'neq' | 'and' | 'or'; lhs: Ast; rhs: Ast };

class Parser {
  private pos = 0;
  constructor(private toks: Token[]) {}

  parse(): Ast {
    const ast = this.parseOr();
    if (this.pos !== this.toks.length) throw new Error('when-expr: trailing tokens');
    return ast;
  }

  private parseOr(): Ast {
    let lhs = this.parseAnd();
    while (this.peekOp('||')) {
      this.pos++;
      const rhs = this.parseAnd();
      lhs = { kind: 'or', lhs, rhs };
    }
    return lhs;
  }

  private parseAnd(): Ast {
    let lhs = this.parseEq();
    while (this.peekOp('&&')) {
      this.pos++;
      const rhs = this.parseEq();
      lhs = { kind: 'and', lhs, rhs };
    }
    return lhs;
  }

  private parseEq(): Ast {
    const lhs = this.parseUnary();
    if (this.peekOp('==')) {
      this.pos++;
      return { kind: 'eq', lhs, rhs: this.parseUnary() };
    }
    if (this.peekOp('!=')) {
      this.pos++;
      return { kind: 'neq', lhs, rhs: this.parseUnary() };
    }
    return lhs;
  }

  private parseUnary(): Ast {
    if (this.peekOp('!')) {
      this.pos++;
      return { kind: 'not', rhs: this.parseUnary() };
    }
    return this.parseAtom();
  }

  private parseAtom(): Ast {
    const t = this.toks[this.pos];
    if (!t) throw new Error('when-expr: unexpected end');
    if (t.kind === 'op' && t.value === '(') {
      this.pos++;
      const inner = this.parseOr();
      const close = this.toks[this.pos];
      if (!close || close.kind !== 'op' || close.value !== ')') throw new Error("when-expr: expected ')'");
      this.pos++;
      return inner;
    }
    if (t.kind === 'var') {
      this.pos++;
      return { kind: 'var', path: t.path };
    }
    if (t.kind === 'str') {
      this.pos++;
      return { kind: 'lit', value: t.value };
    }
    if (t.kind === 'bool') {
      this.pos++;
      return { kind: 'lit', value: t.value };
    }
    throw new Error(`when-expr: unexpected token kind ${t.kind}`);
  }

  private peekOp(v: string): boolean {
    const t = this.toks[this.pos];
    return !!t && t.kind === 'op' && t.value === v;
  }
}

export function parseWhen(input: string): Ast {
  return new Parser(tokenize(input)).parse();
}

function getVar(ctx: Context, path: string): string | boolean | undefined {
  const parts = path.split('.');
  let cur: unknown = ctx;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object' || !(p in (cur as object))) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  if (typeof cur === 'boolean' || typeof cur === 'string') return cur;
  return undefined;
}

function evalAst(ast: Ast, ctx: Context): boolean {
  switch (ast.kind) {
    case 'lit':
      return ast.value === true || (typeof ast.value === 'string' && ast.value !== '');
    case 'var': {
      const v = getVar(ctx, ast.path);
      return v === true || (typeof v === 'string' && v !== '');
    }
    case 'not':
      return !evalAst(ast.rhs, ctx);
    case 'and':
      return evalAst(ast.lhs, ctx) && evalAst(ast.rhs, ctx);
    case 'or':
      return evalAst(ast.lhs, ctx) || evalAst(ast.rhs, ctx);
    case 'eq':
    case 'neq': {
      const l = resolveValue(ast.lhs, ctx);
      const r = resolveValue(ast.rhs, ctx);
      const eq = l === r;
      return ast.kind === 'eq' ? eq : !eq;
    }
  }
}

function resolveValue(ast: Ast, ctx: Context): string | boolean | undefined {
  if (ast.kind === 'lit') return ast.value;
  if (ast.kind === 'var') return getVar(ctx, ast.path);
  throw new Error('when-expr: invalid operand for == / !=');
}

export function evaluateWhen(expr: string | undefined, ctx: Context): boolean {
  if (!expr || expr.trim() === '') return true;
  return evalAst(parseWhen(expr), ctx);
}
```

- [ ] **Step 3: Run** — `pnpm test test/engine/when-expr.test.ts` → all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/engine/when-expr.ts test/engine/when-expr.test.ts
git commit -m "feat(engine): when-expression parser and evaluator with bounded grammar"
```

---

> **End of plan file 1 of 4.** Continue with `2026-05-01-vdx-installer-phase1-engine-core-part2.md` for Tasks 8-N (wizard, install, post-install, transactions). The plan is split into multiple files to stay readable; each part is self-contained and can be executed in order.
