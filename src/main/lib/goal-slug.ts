// Unicode combining diacritical marks (U+0300-U+036F). After NFKD normalize, an accented
// letter splits into base + combining mark; stripping the mark keeps accented goals clean.
const COMBINING_MARKS_REGEX = /[\u0300-\u036f]/g;
const SLUG_STRIP_REGEX = /[^a-z0-9]+/g;
const SLUG_TRIM_REGEX = /^-+|-+$/g;
const MAX_SLUG_LEN = 40;
// Reserved device names on Windows — mkdir of any of these bare names fails.
const WINDOWS_RESERVED_REGEX = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

/** Derive a filesystem-safe kebab slug from free-form goal text. Falls back for empty/non-ASCII. */
export function goalToSlug(goal: string): string {
  const slug = goal
    .toLowerCase()
    .normalize('NFKD')
    .replace(COMBINING_MARKS_REGEX, '')
    .replace(SLUG_STRIP_REGEX, '-')
    .slice(0, MAX_SLUG_LEN)
    .replace(SLUG_TRIM_REGEX, '');
  const safe = slug || 'my-project';
  return WINDOWS_RESERVED_REGEX.test(safe) ? `${safe}-app` : safe;
}
