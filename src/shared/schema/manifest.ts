import { z } from 'zod';
import { APP_ID_REGEX, EXEC_TIMEOUT_MS_MAX, SEMVER_REGEX } from '../constants';

const Localized = z.object({ default: z.string() }).catchall(z.string());
const Sha256Tagged = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Sha256Plain = z.string().regex(/^[a-f0-9]{64}$/);

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
  allowedHashes: z.array(Sha256Tagged).min(1),
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
  size: z.object({
    download: z.number().int().nonnegative(),
    installed: z.number().int().nonnegative(),
  }),
  payload: z.object({
    filename: z.string(),
    sha256: Sha256Plain,
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
  wizard: z
    .array(WizardStep)
    .min(1)
    .refine((steps) => steps[steps.length - 1]?.type === 'summary', {
      message: 'Last wizard step must be of type summary',
    }),
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
