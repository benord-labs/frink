import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { parse as parseDotenv } from 'dotenv';

/** A refusal the user can act on. Its message is shown as-is, so it never carries the value. */
export class SecretRequestError extends Error {
  override name = 'SecretRequestError';
}

const MAX_VALUE_LENGTH = 16_384;
const BARE_VALUE = /^[A-Za-z0-9_\-.:/@+=,~%]+$/;
const ASSIGNMENT = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const DIFFERENT_READS =
  'Not every .env loader reads this value the same way. Add it to the file by hand.';

type Assignment = { key: string; exportPrefix: string; rest: string } | null;

/** Index of the first `quote` at or after `from` that no backslash escapes, or -1. */
function closingQuoteIndex(text: string, quote: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === '\\') index += 1;
    else if (text[index] === quote) return index;
  }
  return -1;
}

/** The quote a value opens without closing on its own line, or null. */
function openQuoteOf(rest: string): string | null {
  const value = rest.trim();
  const quote = value[0];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  return closingQuoteIndex(value, quote, 1) === -1 ? quote : null;
}

/** The quote `rest` opens if a later line closes it; dotenv reads one never closed as one line. */
function multilineQuote(rest: string, later: string[]): string | null {
  const quote = openQuoteOf(rest);
  if (!quote) return null;
  return later.some((line) => closingQuoteIndex(line, quote, 0) !== -1) ? quote : null;
}

/** The assignment on each line; null for comments, blanks and lines inside a multi-line value. */
function assignments(lines: string[]): Assignment[] {
  let openQuote: string | null = null;
  return lines.map((line, index) => {
    if (openQuote) {
      if (closingQuoteIndex(line, openQuote, 0) !== -1) openQuote = null;
      return null;
    }
    const match = ASSIGNMENT.exec(line);
    if (!match) return null;
    const rest = match[3] ?? '';
    openQuote = multilineQuote(rest, lines.slice(index + 1));
    return { key: match[2] ?? '', exportPrefix: match[1] ?? '', rest };
  });
}

export function hasEnvKey(content: string, key: string): boolean {
  return Object.hasOwn(parseDotenv(content), key);
}

/**
 * The edit must read, to Node's dotenv, as the old file with only `key` changed, and the line we
 * wrote must be its only assignment; anything else means a malformed file we could misedit.
 */
function verifyEdit(content: string, next: string, key: string, value: string, line: string) {
  const expected: Record<string, string> = { ...parseDotenv(content), [key]: value };
  const actual = parseDotenv(next);
  const unchanged =
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([name, read]) => actual[name] === read);
  if (!unchanged || Object.hasOwn(parseDotenv(next.replace(line, '')), key)) {
    throw new SecretRequestError(`Frink could not add ${key} to this file safely. Add it by hand.`);
  }
}

/**
 * Pick a quoting that python-dotenv and Node's dotenv both read back unchanged. They disagree on
 * backslash escapes and backticks, and double quotes expand `$VAR`, so those values are refused.
 */
export function quoteEnvValue(value: string): string {
  if (value.length === 0 || value.length > MAX_VALUE_LENGTH) {
    throw new SecretRequestError(`The value must be 1 to ${MAX_VALUE_LENGTH} characters.`);
  }
  if (/[\r\n\0]/.test(value)) {
    throw new SecretRequestError('The value must fit on one line.');
  }
  if (BARE_VALUE.test(value)) return value;
  if (value.includes('\\')) throw new SecretRequestError(DIFFERENT_READS);
  if (!value.includes("'")) return `'${value}'`;
  if (!/["$]/.test(value)) return `"${value}"`;
  throw new SecretRequestError(DIFFERENT_READS);
}

/** Set `key` in dotenv text: replace the first line for it, drop later duplicates, else append. */
export function upsertEnvLine(content: string, key: string, value: string): string {
  const quoted = quoteEnvValue(value);
  // Split on either ending so no line hides inside a neighbour; the file is written back with one.
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content === '' ? [] : content.split(/\r?\n/);
  const parsed = assignments(lines);
  const out: string[] = [];
  let written: string | null = null;
  for (const [index, line] of lines.entries()) {
    const entry = parsed[index];
    if (entry?.key !== key) {
      out.push(line);
      continue;
    }
    if (multilineQuote(entry.rest, lines.slice(index + 1))) {
      throw new SecretRequestError(`${key} spans several lines in this file. Edit it by hand.`);
    }
    if (written) continue;
    written = `${entry.exportPrefix}${key}=${quoted}`;
    out.push(written);
  }
  if (!written) {
    written = `${key}=${quoted}`;
    if (out.at(-1) === '') out.splice(out.length - 1, 0, written);
    else out.push(written, '');
  }
  const next = out.join(eol);
  verifyEdit(content, next, key, value, written);
  return next;
}

/** Replace `target` in one rename, keeping its mode (0600 for a new file). */
export async function writeEnvFileAtomic(target: string, content: string): Promise<void> {
  const mode = await fs.stat(target).then(
    (stat) => stat.mode & 0o777,
    () => 0o600,
  );
  const tmpPath = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmpPath, content, { encoding: 'utf8', flag: 'wx', mode });
    // writeFile's mode is masked by the umask; set it exactly.
    await fs.chmod(tmpPath, mode);
    await fs.rename(tmpPath, target);
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}

const fileQueues = new Map<string, Promise<unknown>>();

/** Runs `task` after every earlier one for `target`, so two saves never interleave read and write. */
export function serializeForFile<T>(target: string, task: () => Promise<T>): Promise<T> {
  const next = (fileQueues.get(target) ?? Promise.resolve()).catch(() => {}).then(task);
  fileQueues.set(target, next);
  next
    .finally(() => {
      if (fileQueues.get(target) === next) fileQueues.delete(target);
    })
    .catch(() => {});
  return next;
}
