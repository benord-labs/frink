/** Literal `$(cat <<'DELIM' … DELIM\n)` substitutions (the commit-message idiom). Pure, no I/O. */

/** Leading tabs a `<<-` closer may be indented with. */
const LEADING_TABS_REGEX = /^\t+/;
/** Bash expands nothing in a heredoc body whose delimiter is 'quoted' or \escaped. */
const SUBSTITUTION_OPENER = '$(cat';
const DELIMITER_WORD_REGEX = /[A-Za-z_]\w*/y;
const BLANKS_THEN_CLOSE_PAREN_REGEX = /^[ \t]*\)/;
/** Real commands carry one or two openers; past this the command stays exact-match-only. */
const MAX_SAFE_HEREDOC_CANDIDATES = 32;

type LiteralOpener = { delimiter: string; stripTabs: boolean; bodyStart: number };
/** `[start, end)` spans the whole quoted argument; `value` is what bash expands it to. */
type LiteralRange = { start: number; end: number; value: string };
type BodyEnd = { closerLineStart: number; end: number };

function skipBlanks(text: string, i: number): number {
  while (text[i] === ' ' || text[i] === '\t') i++;
  return i;
}

function readDelimiterWord(text: string, i: number): string | null {
  DELIMITER_WORD_REGEX.lastIndex = i;
  return DELIMITER_WORD_REGEX.exec(text)?.[0] ?? null;
}

/** `'DELIM'` (balanced repeated quotes allowed) or `\\DELIM` at `i`; `end` is just past it. */
function readQuotedDelimiter(command: string, i: number): { word: string; end: number } | null {
  if (command[i] === '\\') {
    const word = readDelimiterWord(command, i + 1);
    return word ? { word, end: i + 1 + word.length } : null;
  }
  let quotes = 0;
  while (command[i + quotes] === "'") quotes++;
  const word = quotes > 0 ? readDelimiterWord(command, i + quotes) : null;
  if (!word) return null;
  const close = i + quotes + word.length;
  const balanced = command.slice(close, close + quotes) === "'".repeat(quotes);
  return balanced && command[close + quotes] !== "'" ? { word, end: close + quotes } : null;
}

/** Parse `<<[-] 'DELIM'` after `$(cat`; the opener line must end right after the delimiter. */
function readLiteralOpener(command: string, i: number): LiteralOpener | null {
  i = skipBlanks(command, i);
  if (!command.startsWith('<<', i)) return null;
  const stripTabs = command[i + 2] === '-';
  const delimiter = readQuotedDelimiter(command, skipBlanks(command, i + (stripTabs ? 3 : 2)));
  if (!delimiter) return null;
  const lineEnd = command.indexOf('\n', delimiter.end);
  if (lineEnd === -1 || skipBlanks(command, delimiter.end) !== lineEnd) return null;
  return { delimiter: delimiter.word, stripTabs, bodyStart: lineEnd + 1 };
}

function lineEndAt(command: string, from: number): number {
  const end = command.indexOf('\n', from);
  return end === -1 ? command.length : end;
}

function skipTabs(command: string, i: number): number {
  while (command[i] === '\t') i++;
  return i;
}

/** Index past the `)` that follows the delimiter on its line or opens the next line, or -1. */
function closingParenEnd(command: string, afterDelimiter: number, lineEnd: number): number {
  const rest = command.slice(afterDelimiter, lineEnd);
  if (BLANKS_THEN_CLOSE_PAREN_REGEX.test(rest)) return command.indexOf(')', afterDelimiter) + 1;
  if (rest !== '' || lineEnd === command.length) return -1;
  const next = command.slice(lineEnd + 1, lineEndAt(command, lineEnd + 1));
  return BLANKS_THEN_CLOSE_PAREN_REGEX.test(next) ? command.indexOf(')', lineEnd + 1) + 1 : -1;
}

/** Closer line and index past the closing `)`, or null. The first line starting with the delimiter decides. */
function findLiteralBodyEnd(command: string, opener: LiteralOpener): BodyEnd | null {
  for (let lineStart = opener.bodyStart; lineStart <= command.length;) {
    const lineEnd = lineEndAt(command, lineStart);
    const contentStart = opener.stripTabs ? skipTabs(command, lineStart) : lineStart;
    if (command.startsWith(opener.delimiter, contentStart)) {
      const end = closingParenEnd(command, contentStart + opener.delimiter.length, lineEnd);
      return end === -1 ? null : { closerLineStart: lineStart, end };
    }
    lineStart = lineEnd + 1;
  }
  return null;
}

/** Unquoted characters that end one simple command (or open a group, case arm or subshell). */
const COMMAND_BOUNDARY_CHARS = new Set([';', '&', '|', '\n', '\r', '(', ')', '{', '}', '`']);
/** A plain command word: no assignment, redirection, quote, expansion or glob. */
const PLAIN_WORD_REGEX = /^[\w./][\w./+-]*$/;
const RESERVED_WORDS = new Set([
  'case',
  'coproc',
  'do',
  'done',
  'elif',
  'else',
  'esac',
  'fi',
  'for',
  'function',
  'if',
  'in',
  'select',
  'then',
  'time',
  'until',
  'while',
]);

/** Allow-list: the substitution is an argument of a simple command that starts with a plain word. */
function isArgumentOfPlainCommand(segmentBeforeQuote: string): boolean {
  if (!/[ \t]$/.test(segmentBeforeQuote)) return false;
  const head = segmentBeforeQuote.trim().split(/[ \t]+/)[0];
  return PLAIN_WORD_REGEX.test(head) && !RESERVED_WORDS.has(head);
}

/**
 * Quote-aware walk for `"$(cat <<'D' … D\n)"` forming one whole double-quoted argument.
 * Null past the opener cap; bodies of accepted ranges are skipped, so ranges never overlap.
 */
function findLiteralHeredocRanges(command: string): LiteralRange[] | null {
  const ranges: LiteralRange[] = [];
  let openers = 0;
  let segmentStart = 0;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\\') i++;
    else if (ch === "'") i = closingQuote(command, i + 1, "'");
    else if (COMMAND_BOUNDARY_CHARS.has(ch)) segmentStart = i + 1;
    else if (ch === '"') {
      const range = acceptedRange(command, i, segmentStart, () => ++openers);
      if (openers > MAX_SAFE_HEREDOC_CANDIDATES) return null;
      if (range) ranges.push(range);
      i = range ? range.end - 1 : closingQuote(command, i + 1, '"');
    }
  }
  return ranges;
}

/** Index of the quote closing a `quote` string opened before `from` (or the end of input). */
function closingQuote(command: string, from: number, quote: "'" | '"'): number {
  for (let j = from; j < command.length; j++) {
    if (quote === '"' && command[j] === '\\') j++;
    else if (command[j] === quote) return j;
  }
  return command.length;
}

/** The substitution opening just inside the `"` at `quote`, if it is acceptable; else null. */
function acceptedRange(
  command: string,
  quote: number,
  segmentStart: number,
  countOpener: () => void,
): LiteralRange | null {
  const at = quote + 1;
  if (!command.startsWith(SUBSTITUTION_OPENER, at)) return null;
  const opener = readLiteralOpener(command, at + SUBSTITUTION_OPENER.length);
  if (!opener) return null;
  countOpener();
  const body = findLiteralBodyEnd(command, opener);
  if (!body || command[body.end] !== '"') return null;
  const raw = command.slice(opener.bodyStart, body.closerLineStart);
  if (raw.includes('<<')) return null;
  if (!isArgumentOfPlainCommand(command.slice(segmentStart, quote))) return null;
  const lines = raw.replace(/\n+$/, '').split('\n');
  const value = (
    opener.stripTabs ? lines.map((l) => l.replace(LEADING_TABS_REGEX, '')) : lines
  ).join('\n');
  return { start: quote, end: body.end + 1, value };
}

/** Single-quote `value` for bash: no expansion, `'` spelled `'\\''`. */
function singleQuoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Replace each literal heredoc substitution with the single-quoted text it expands to, so rules and
 * path checks see the real argument. Null when none is acceptable; the caller keeps the original.
 */
export function inlineLiteralHeredocSubstitutions(command: string): string | null {
  const ranges = findLiteralHeredocRanges(command);
  if (!ranges || ranges.length === 0) return null;
  let result = command;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const { start, end, value } = ranges[i];
    result = result.slice(0, start) + singleQuoted(value) + result.slice(end);
  }
  // Anything left that the walk cannot model (heredocs, substitutions) could desync its quoting.
  return /<<|\$\(|`/.test(result) ? null : result;
}
