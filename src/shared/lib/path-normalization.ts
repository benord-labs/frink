const BACKSLASH_REGEX = /\\/g;
const TRAILING_SLASHES_REGEX = /\/+$/;
const WINDOWS_DRIVE_ROOT_REGEX = /^[A-Za-z]:$/;
const WINDOWS_ABSOLUTE_PATH_REGEX = /^[A-Za-z]:[\\/]/;
const WINDOWS_DRIVE_PATH_REGEX = /^[a-z]:\//i;

export function normalizePathSlashes(inputPath: string): string {
  return inputPath.replace(BACKSLASH_REGEX, '/');
}

export function trimTrailingSlashes(inputPath: string): string {
  return inputPath.replace(TRAILING_SLASHES_REGEX, '');
}

/** A path in one comparable form: forward slashes, no trailing slash, and a lower-cased Windows
 *  drive path (Windows paths are case-insensitive). */
export function normalizePathForComparison(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = trimTrailingSlashes(normalizePathSlashes(value));
  return WINDOWS_DRIVE_PATH_REGEX.test(normalized) ? normalized.toLowerCase() : normalized;
}

/** Whether two folder paths name the same folder, by normalizePathForComparison. */
export function isSameFolder(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normalizePathForComparison(a) === normalizePathForComparison(b);
}

export function isRootLikePath(inputPath: string): boolean {
  const normalized = trimTrailingSlashes(normalizePathSlashes(inputPath.trim()));
  return normalized.length === 0 || normalized === '/' || WINDOWS_DRIVE_ROOT_REGEX.test(normalized);
}

export function isWindowsAbsolutePath(inputPath: string): boolean {
  return WINDOWS_ABSOLUTE_PATH_REGEX.test(inputPath) || inputPath.startsWith('\\\\');
}

/** A URI-encoded path, or the path as written when it is not valid URI encoding. */
export function decodeUriPath(inputPath: string): string {
  try {
    return decodeURIComponent(inputPath);
  } catch {
    return inputPath;
  }
}
