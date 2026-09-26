import * as os from 'node:os';
import * as path from 'node:path';
import { expandHomePath } from '../../../shared/lib/expand-home';
import {
  SENSITIVE_HOME_PATHS,
  SENSITIVE_UNIX_PREFIXES,
} from '../../../shared/lib/worktree-sensitive-paths';

const ROOT_DIRS = new Set(['/']);

export { expandHomePath };

export function normalizeWorktreeBasePath(inputPath: string): string {
  return path.resolve(expandHomePath(inputPath.trim()));
}

export function isAbsoluteWorktreeBasePathInput(inputPath: string): boolean {
  const expanded = expandHomePath(inputPath.trim());
  return path.isAbsolute(expanded);
}

export function isSensitiveWorktreeBasePath(normalizedPath: string): boolean {
  const rootPath = path.parse(normalizedPath).root;
  if (normalizedPath === rootPath || ROOT_DIRS.has(normalizedPath)) {
    return true;
  }

  const normalizedHome = os.homedir();
  if (normalizedPath === normalizedHome || normalizedPath === path.join(normalizedHome, '.frink')) {
    return true;
  }

  if (
    SENSITIVE_UNIX_PREFIXES.some(
      (prefix) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`),
    )
  ) {
    return true;
  }

  if (
    SENSITIVE_HOME_PATHS.some(
      (homePathName) =>
        normalizedPath === path.join(normalizedHome, homePathName) ||
        normalizedPath.startsWith(`${path.join(normalizedHome, homePathName)}${path.sep}`),
    )
  ) {
    return true;
  }

  return false;
}

export function isSafeConfiguredWorktreeBasePath(configuredPath: string): boolean {
  if (!isAbsoluteWorktreeBasePathInput(configuredPath)) {
    return false;
  }
  const normalizedPath = normalizeWorktreeBasePath(configuredPath);
  return !isSensitiveWorktreeBasePath(normalizedPath);
}
