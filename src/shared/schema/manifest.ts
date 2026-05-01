import { z } from 'zod';
import { APP_ID_REGEX, EXEC_TIMEOUT_MS_MAX, SEMVER_REGEX } from '../constants';

const Localized = z.object({ default: z.string() }).catchall(z.string());
const Sha256Tagged = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Sha256Plain = z.string().regex(/^[a-f0-9]{64}$/);

/** Reject NUL + other C0 controls. Win32 string handling truncates at NUL,
 *  silently turning a registry valueName into "" (the `(Default)` slot) and
 *  splitting REG_MULTI_SZ entries mid-string. Apply to every manifest string
 *  that flows into reg.exe / shortcut filenames / shell args.
 *  The control-character class *is* the point of this check — disable the
 *  lint rule that flags raw control chars in regexes. */
// eslint-disable-next-line no-control-regex
const NoControlChars = z.string().refine((s) => !/[\x00-\x1f\x7f]/.test(s), {
  message: 'Control characters are not allowed in this field',
});

/** Filename-safe charset for shortcut.name and similar fields that become
 *  literal disk filenames. No path separators, no NUL/controls, no leading/
 *  trailing whitespace, length-bounded so a malicious manifest can't escape
 *  the start-menu directory or create a path that exceeds NTFS limits. */
const FilenameSafe = z
  .string()
  .min(1)
  .max(120)
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[\x00-\x1f\x7f/\\:*?"<>|]/.test(s), {
    message: 'Field contains characters not allowed in filenames',
  })
  .refine((s) => s.trim() === s, {
    message: 'Leading or trailing whitespace is not allowed',
  });

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
  target: NoControlChars,
  // FilenameSafe — shortcut name lands on disk as `${dir}/${name}.lnk`. Without
  // this constraint a manifest could publish `name = "../../evil"` and write
  // a .lnk outside the StartMenu/Desktop directory.
  name: FilenameSafe,
  args: NoControlChars.optional(),
  when: z.string().optional(),
});

// REG_MULTI_SZ entries: in addition to NoControlChars, reject the literal
// two-character sequence `\0` (backslash followed by zero). The Windows
// platform impl uses that exact substring as the entry separator when it
// shells out to reg.exe; an entry containing `\0` would split mid-value
// during the reg.exe round-trip and produce a different array on read-back.
const MultiSzEntry = NoControlChars.refine((s) => !s.includes('\\0'), {
  message: 'REG_MULTI_SZ entry must not contain the literal sequence "\\0" (backslash + zero)',
});

const RegistryValue = z.object({
  type: z.enum(['REG_SZ', 'REG_DWORD', 'REG_QWORD', 'REG_EXPAND_SZ', 'REG_MULTI_SZ', 'REG_BINARY']),
  // Reject NUL/control bytes in REG_SZ-style strings — Win32 truncates at NUL,
  // and a NUL inside a REG_MULTI_SZ entry would split it mid-string. Number
  // and array forms are recursively constrained.
  data: z.union([
    NoControlChars,
    z.number(),
    z.array(MultiSzEntry),
  ]),
});

const RegistryAction = z.object({
  type: z.literal('registry'),
  hive: z.enum(['HKCU', 'HKLM']),
  // Registry key path: forbid control bytes, but allow `\` (Windows separator).
  key: NoControlChars,
  // Value names must not contain NUL — Win32 truncates and silently overwrites
  // the (Default) slot. Empty key = `(Default)` is intentional in some flows;
  // we keep min:0 but bar control bytes.
  values: z.record(NoControlChars, RegistryValue),
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
  // publisher flows into ARP `Publisher` REG_SZ; reject NUL so it can't mask
  // its own entry in Add/Remove Programs.
  publisher: NoControlChars.refine((s) => s.length >= 1, { message: 'publisher required' }),
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
}).strict();

export type Manifest = z.infer<typeof ManifestSchema>;
export type WizardStepT = z.infer<typeof WizardStep>;
export type PostInstallActionT = z.infer<typeof PostInstallAction>;
