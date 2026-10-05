// Git log output is parsed with ASCII control separators rather than '|' so
// subjects/bodies containing '|' or newlines cannot shift or split fields.
export const FIELD_SEP = '\x1f';
export const RECORD_SEP = '\x1e';

/** Build a `--format=` argument whose fields/records use FIELD_SEP/RECORD_SEP. */
export function logFormat(...placeholders: string[]): string {
  return `--format=${placeholders.join('%x1f')}%x1e`;
}

/**
 * `git log` argv for a `logFormat` string. `--no-show-signature` overrides a user's
 * `log.showSignature=true`, which would otherwise verify every signed commit and
 * print the result to stdout ahead of each record.
 */
export function gitLogArgs(format: string, ...revArgs: string[]): string[] {
  return ['log', '--no-show-signature', ...revArgs, format];
}

/** Normalise a git date to ISO, falling back to "now" when missing or unparseable. */
export function toSafeIsoDate(dateStr: string | undefined): string {
  const parsed = new Date(dateStr || '');
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

/** Split `logFormat` output into records of exactly `fieldCount` fields. */
export function splitLogRecords(output: string, fieldCount: number): string[][] {
  const records: string[][] = [];
  for (const raw of output.split(RECORD_SEP)) {
    // git separates each formatted entry from the next with a newline
    const record = raw.replace(/^\r?\n/, '');
    if (!record.trim()) continue;
    const fields = record.split(FIELD_SEP);
    if (fields.length !== fieldCount) continue;
    // Lines git prints ahead of a record (e.g. signature checks) land in the first
    // field; formats here always start with a single-line placeholder (%H), so keep its last line.
    fields[0] = fields[0]!.slice(fields[0]!.lastIndexOf('\n') + 1);
    records.push(fields);
  }
  return records;
}

export const COMMIT_HISTORY_FORMAT = logFormat('%H', '%h', '%s', '%an', '%ae', '%aI');

export interface CommitHistoryEntry {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  email: string;
  date: string;
}

/** Parse `git log` output produced with COMMIT_HISTORY_FORMAT. */
export function parseCommitHistory(output: string): CommitHistoryEntry[] {
  return splitLogRecords(output, 6).map(([hash, shortHash, message, author, email, dateStr]) => ({
    hash: hash?.trim() || '',
    shortHash: shortHash?.trim() || '',
    message: message?.trim() || '',
    author: author?.trim() || '',
    email: email?.trim() || '',
    date: toSafeIsoDate(dateStr?.trim()),
  }));
}
