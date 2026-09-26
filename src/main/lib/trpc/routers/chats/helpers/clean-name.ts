const MAX_NAME_LEN = 50;
const TITLE_PREFIX_RE = /^title:\s*/i;
// Match a leading quoted span, pairing each opening quote with its OWN closing
// quote so apostrophes inside a double-quoted title (e.g. "Don't fix") aren't
// mistaken for the closing delimiter.
const QUOTED_SPAN_RE = /^"([^"\n]+)"|^'([^'\n]+)'|^“([^”\n]+)”|^‘([^’\n]+)’/;
const WRAPPING_QUOTE_RE = /^["'“‘]+|["'”’]+$/g;
const WHITESPACE_RE = /\s+/g;
const WORD_SPLIT_RE = /\s+/;
const LEADING_LIST_PREFIX_RE = /^\s*(?:\d+[.)]\s+|[-*+]\s+)/;
const LEADING_EMOJI_OR_SPACE_RE = /^(?:\p{Extended_Pictographic}|️|\s)+/u;

/**
 * Extract one clean title from possibly-verbose model output.
 *
 * Small models often ignore "only output the title" on trivial inputs and
 * return multiple quoted candidates (e.g. `"Hello!" or "Welcome!" or "Hi!"`)
 * or a multi-line preamble. We take the first line, then the first quoted
 * span if present, so the persisted title is a single clean phrase.
 */
export function cleanGeneratedName(raw: string): string | null {
  // Bound the working string before regex/loop work — model output should be a
  // short title; anything longer is malformed and we only keep 50 chars anyway.
  const firstLine = raw.trim().split('\n')[0]?.trim().slice(0, 500) ?? '';
  const quoted = firstLine.match(QUOTED_SPAN_RE);
  const inner = quoted
    ? (quoted[1] ?? quoted[2] ?? quoted[3] ?? quoted[4] ?? firstLine)
    : firstLine;
  let candidate = inner
    .replace(TITLE_PREFIX_RE, '')
    .replace(WRAPPING_QUOTE_RE, '')
    .replace(WHITESPACE_RE, ' ')
    .trim();

  // Strip prefixed list/emoji markers LLMs sometimes prepend (e.g. "1. 🚀 Fix auth").
  let previous = '';
  while (candidate !== previous) {
    previous = candidate;
    candidate = candidate
      .replace(LEADING_LIST_PREFIX_RE, '')
      .replace(LEADING_EMOJI_OR_SPACE_RE, '')
      .trim();
  }

  candidate = candidate.slice(0, MAX_NAME_LEN);
  return candidate.length > 0 ? candidate : null;
}

const MAX_TITLE_WORDS = 5;

/**
 * True when `name` has at least two whitespace-separated tokens. A hyphenated
 * single token (e.g. "auth-bug") counts as one word.
 */
export function isMultiWord(name: string): boolean {
  return name.trim().split(WORD_SPLIT_RE).filter(Boolean).length >= 2;
}

/**
 * Shape a raw user message into a short Title-Case phrase (≤5 words, ≤50 chars)
 * for use as a chat title — a title, NOT the raw-message slice `getFallbackName`
 * returns. Used to reshape a single-word AI title into a ≥2-word one. Returns ''
 * when the message has no words, so callers can fall back further. First-letter
 * casing only, so acronyms (API, SQL) survive.
 */
export function tidyToTitle(message: string): string {
  const words = message.trim().split(WORD_SPLIT_RE).filter(Boolean).slice(0, MAX_TITLE_WORDS);
  if (words.length === 0) return '';
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
    .slice(0, MAX_NAME_LEN);
}
