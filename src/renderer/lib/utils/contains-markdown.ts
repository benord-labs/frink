/**
 * Heuristic: does `text` contain markdown worth rendering?
 *
 * Drives whether a chat bubble shows the raw/rendered toggle — so it must NOT
 * false-positive on ordinary prompts. Signals are split into two tiers:
 *
 * - **Strong** — constructs that rarely occur incidentally in prose (`**bold**`,
 *   `~~strike~~`, backtick code, ATX headings, `[text](url)` links). A single
 *   match is enough.
 * - **Weak** — line-anchored constructs that plain text imitates (`1. buy milk`,
 *   `- a dash`, `> quote`, a stray `|`). Counted only when corroborated: two or
 *   more weak lines, OR one weak line alongside a strong signal.
 */

// Strong signals — one match implies markdown intent.
const STRONG_PATTERNS: RegExp[] = [
  /\*\*[^\s*][^*]*\*\*/, // **bold**
  /__[^\s_][^_]*__/, // __bold__
  /~~[^\s~][^~]*~~/, // ~~strike~~
  /`[^`\n]+`/, // `inline code`
  /(^|\n)```/, // ``` fenced code
  /(^|\n)#{1,6}\s+\S/, // # ATX heading
  /\[[^\]\n]+\]\([^)\s]+\)/, // [text](url)
];

// Weak signals — line-anchored, prose imitates them. Need corroboration.
const WEAK_LINE_PATTERNS: RegExp[] = [
  /^\s*[-*+]\s+\S/, // - unordered list item
  /^\s*\d+\.\s+\S/, // 1. ordered list item
  /^\s*>\s+\S/, // > blockquote
  /^\s*\|.*\|\s*$/, // | table | row |
];

export function containsMarkdown(text: string): boolean {
  if (!text) return false;

  const hasStrong = STRONG_PATTERNS.some((re) => re.test(text));
  if (hasStrong) return true;

  // No strong signal: weak signals only count when corroborated by ≥2 weak lines.
  let weakLineCount = 0;
  for (const line of text.split('\n')) {
    if (WEAK_LINE_PATTERNS.some((re) => re.test(line))) {
      weakLineCount++;
      if (weakLineCount >= 2) return true;
    }
  }

  return false;
}
