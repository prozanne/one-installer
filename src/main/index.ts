export { runInstall } from './engine/install';
export type { InstallInput, InstallSuccess } from './engine/install';
export { runUninstall } from './engine/uninstall';
export type { UninstallInput } from './engine/uninstall';
export { validateManifestSemantics } from './engine/validate';
export type { ValidateInput } from './engine/validate';
export {
  diffWizardForReuse,
  validateAnswer,
  computeWizardOrder,
  type WizardDiff,
} from './engine/wizard';
export { parseVdxpkg } from './packages/vdxpkg';
export type { ParsedVdxpkg } from './packages/vdxpkg';
export { createTransactionRunner } from './engine/transaction';
export type { Transaction, TransactionRunner } from './engine/transaction';
export { createJournalStore } from './state/journal-store';
export type { JournalStore } from './state/journal-store';
export { createInstalledStore } from './state/installed-store';
export type { InstalledStore } from './state/installed-store';
export { acquireAppLock } from './state/lock';
export type { AppLock } from './state/lock';
export { createConsoleLogger } from './logging/logger';
export type { Logger, LogLevel } from './logging/logger';
export { redact } from './logging/redact';
export type { Platform, ExecResult, ExecInput, RegistryValue, ShortcutInput } from './platform';
export { MockPlatform } from './platform';
