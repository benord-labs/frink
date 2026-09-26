const BACKSLASH_REGEX = /\\/g;
const TRAILING_SLASHES_REGEX = /\/+$/;
const WINDOWS_DRIVE_ROOT_REGEX = /^[A-Za-z]:$/;
const WINDOWS_ABSOLUTE_PATH_REGEX = /^[A-Za-z]:[\\/]/;

export function normalizePathSlashes(inputPath: string): string {
  return inputPath.replace(BACKSLASH_REGEX, '/');
}

export function trimTrailingSlashes(inputPath: string): string {
  return inputPath.replace(TRAILING_SLASHES_REGEX, '');
}

export function isRootLikePath(inputPath: string): boolean {
  const normalized = trimTrailingSlashes(normalizePathSlashes(inputPath.trim()));
  return normalized.length === 0 || normalized === '/' || WINDOWS_DRIVE_ROOT_REGEX.test(normalized);
}

export function isWindowsAbsolutePath(inputPath: string): boolean {
  return WINDOWS_ABSOLUTE_PATH_REGEX.test(inputPath) || inputPath.startsWith('\\\\');
}
