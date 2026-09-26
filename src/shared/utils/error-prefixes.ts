const NON_RETRIABLE_ERROR_PREFIX = /^NonRetriableError:\s*/i;
const RETRIABLE_ERROR_PREFIX = /^RetriableError:\s*/i;
const ERROR_PREFIX = /^Error:\s*/i;

type NormalizeErrorOptions = {
  stripRetriablePrefix?: boolean;
};

/**
 * Removes common SDK/CLI error type prefixes so user-facing text is cleaner.
 * Keeps the rest of the original message untouched.
 */
export function normalizeErrorTextPrefix(raw: string, options: NormalizeErrorOptions = {}): string {
  const stripRetriablePrefix = options.stripRetriablePrefix ?? false;
  let normalized = raw.replace(NON_RETRIABLE_ERROR_PREFIX, '');
  if (stripRetriablePrefix) {
    normalized = normalized.replace(RETRIABLE_ERROR_PREFIX, '');
  }
  normalized = normalized.replace(ERROR_PREFIX, '');
  return normalized.trim();
}
