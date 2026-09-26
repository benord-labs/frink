import { existsSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';

type ErrorHandler = (error: Error) => Promise<void> | void;

export interface ReplaceDirectoryOptions {
  /** Backup location on the same filesystem as the source and destination. */
  backupPath: string;
  /** Override the destination probe when the caller already knows whether it exists. */
  destinationExists?: boolean;
  /** Makes post-swap backup cleanup best-effort when provided. */
  onCleanupError?: ErrorHandler;
  /** Observes a failed rollback without replacing the original swap error. */
  onRestoreError?: ErrorHandler;
  /** Verifies the captured previous destination before the replacement is installed. */
  verifyBackup?: (backupPath: string) => Promise<void>;
  /** Opts into post-rename verification before the previous destination is discarded. */
  verifyDestination?: (destinationPath: string) => Promise<void>;
}

async function notifyError(handler: ErrorHandler, error: Error): Promise<void> {
  try {
    await handler(error);
  } catch {
    // Error reporting must not replace the filesystem error that triggered it.
  }
}

async function restoreBackup(
  backupPath: string,
  destinationPath: string,
  onRestoreError?: ErrorHandler,
): Promise<void> {
  try {
    await rename(backupPath, destinationPath);
  } catch (restoreError) {
    if (onRestoreError) {
      await notifyError(
        onRestoreError,
        restoreError instanceof Error ? restoreError : new Error(String(restoreError)),
      );
    }
  }
}

async function removeBackup(backupPath: string, onCleanupError?: ErrorHandler): Promise<void> {
  try {
    await rm(backupPath, { recursive: true, force: true });
  } catch (cleanupError) {
    if (!onCleanupError) throw cleanupError;
    await notifyError(
      onCleanupError,
      cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
    );
  }
}

function recoveryError(
  replacementError: Error,
  restoreError: Error,
  recoveryPath: string,
  hasBackup: boolean,
): Error {
  const location = hasBackup
    ? `Previous directory backup preserved at "${recoveryPath}".`
    : `Unverified destination remains at "${recoveryPath}".`;
  const error = new Error(
    `Directory replacement failed (${replacementError.message}) and rollback failed (${restoreError.message}). ${location}`,
  );
  error.cause = replacementError;
  return error;
}

async function rollbackVerifiedReplacement(
  destinationPath: string,
  options: ReplaceDirectoryOptions,
  backupCaptured: boolean,
  destinationReplaced: boolean,
  replacementError: Error,
): Promise<void> {
  try {
    if (destinationReplaced) await rm(destinationPath, { recursive: true, force: true });
    if (backupCaptured) await rename(options.backupPath, destinationPath);
  } catch (restoreError) {
    const normalizedRestoreError =
      restoreError instanceof Error ? restoreError : new Error(String(restoreError));
    if (options.onRestoreError) await notifyError(options.onRestoreError, normalizedRestoreError);
    throw recoveryError(
      replacementError,
      normalizedRestoreError,
      backupCaptured ? options.backupPath : destinationPath,
      backupCaptured,
    );
  }
}

async function replaceVerifiedDirectory(
  sourcePath: string,
  destinationPath: string,
  options: ReplaceDirectoryOptions,
  destinationExists: boolean,
): Promise<void> {
  let backupCaptured = false;
  let destinationReplaced = false;
  try {
    if (destinationExists) {
      await rename(destinationPath, options.backupPath);
      backupCaptured = true;
      await options.verifyBackup?.(options.backupPath);
    }
    await rename(sourcePath, destinationPath);
    destinationReplaced = true;
    await options.verifyDestination?.(destinationPath);
  } catch (replacementError) {
    const normalizedReplacementError =
      replacementError instanceof Error ? replacementError : new Error(String(replacementError));
    await rollbackVerifiedReplacement(
      destinationPath,
      options,
      backupCaptured,
      destinationReplaced,
      normalizedReplacementError,
    );
    throw normalizedReplacementError;
  }
  if (backupCaptured) await removeBackup(options.backupPath, options.onCleanupError);
}

/**
 * Replace a directory using same-filesystem renames and a caller-owned backup path.
 * Without verification, restoration remains best-effort for existing callers. Verified swaps
 * retain the backup until validation and surface its recovery path if strict rollback fails.
 */
export async function replaceDirectory(
  sourcePath: string,
  destinationPath: string,
  options: ReplaceDirectoryOptions,
): Promise<void> {
  const destinationExists = options.destinationExists ?? existsSync(destinationPath);

  if (options.verifyDestination || options.verifyBackup) {
    await replaceVerifiedDirectory(sourcePath, destinationPath, options, destinationExists);
    return;
  }

  if (destinationExists) {
    await rename(destinationPath, options.backupPath);
  }

  try {
    await rename(sourcePath, destinationPath);
  } catch (swapError) {
    if (destinationExists) {
      await restoreBackup(options.backupPath, destinationPath, options.onRestoreError);
    }
    throw swapError;
  }

  if (!destinationExists) return;
  await removeBackup(options.backupPath, options.onCleanupError);
}
