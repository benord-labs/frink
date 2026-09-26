/**
 * Detects Claude Code usage-limit terminations ("You've hit your limit · resets 2:20pm").
 * The limit surfaces in two shapes: an SDK error result ("Claude Code returned an error
 * result: <limit text>") or a clean stream whose final assistant text part IS the limit
 * message. Detection runs in the main process so flow tasks park as `needs_attention`
 * regardless of whether the chat UI is mounted.
 */

import { type FinalPartLike, trailingTextPart } from './trailing-text';

/** Limit messages are one-liners; anything longer is an agent quoting the phrase. */
const MAX_LIMIT_TEXT_LENGTH = 300;

/** CLI copy may use a typographic apostrophe (U+2019) — normalize before phrase matching. */
function normalizeLimitText(text: string): string {
  return text.toLowerCase().replace(/’/g, "'");
}

export function isUsageLimitText(text: string): boolean {
  if (text.length > MAX_LIMIT_TEXT_LENGTH) return false;
  const normalized = normalizeLimitText(text);
  return (
    normalized.includes("you've hit your limit") ||
    normalized.includes('usage limit reached') ||
    normalized.includes('hit the claude code usage limit') ||
    // Covers timed variants like "5-hour limit reached ∙ resets 3am".
    (normalized.includes('limit reached') && normalized.includes('resets'))
  );
}

/**
 * The clean-stream limit message is the ENTIRE final text part (e.g. "You've hit your
 * limit · resets 2:20pm"), so the part must START with a limit phrase. A bare `includes`
 * is too loose here: consecutive text deltas merge into one part, so an agent quoting the
 * phrase mid-sentence would otherwise match.
 */
const TRAILING_LIMIT_PATTERN =
  /^\s*(you've hit your limit|you've hit the claude code usage limit|claude ai usage limit reached|usage limit reached|\d+-hour limit reached)/i;

/**
 * Returns the usage-limit text when it is the FINAL meaningful part of an assistant
 * message, else null. Only the trailing text part is inspected — the limit phrase can
 * legitimately appear inside earlier text or tool outputs (e.g. an agent writing tests
 * that quote it).
 */
export function extractTrailingUsageLimitText(parts: ReadonlyArray<FinalPartLike>): string | null {
  const text = trailingTextPart(parts);
  if (text === null || text.length > MAX_LIMIT_TEXT_LENGTH) return null;
  return TRAILING_LIMIT_PATTERN.test(normalizeLimitText(text)) ? text : null;
}
