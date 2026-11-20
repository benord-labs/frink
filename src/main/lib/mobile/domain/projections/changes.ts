import { posix, win32 } from 'node:path';
import type {
  MobileChangedFile,
  MobileChatChanges,
  MobileDiffLine,
} from '../../../../../shared/types/remote/mobile';
import { splitUnifiedDiffByFile, type ParsedDiffFile } from '../../../git/diff-parser';
import { getWorktreeDiff } from '../../../git/worktree/diff';
import { isSystemDeniedPath } from '../../../permissions/v2/system-denied-patterns';
import { MobileApiError } from '../errors';

/** Parsing runs on the main thread (about 0.1 s for 8 MiB), so a larger diff is not parsed. */
export const MAX_DIFF_CHARS = 8 * 1024 * 1024;
/** The answer's cap in serialized bytes: file entries first, then diff lines while room is left. */
export const MAX_ANSWER_BYTES = 120 * 1024;
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export const NO_CHANGES: MobileChatChanges = {
  additions: 0,
  deletions: 0,
  fileCount: 0,
  files: [],
  truncated: false,
};

type Hunk = MobileChangedFile['hunks'][number];

function pathOf(file: ParsedDiffFile): string {
  return file.isDeletedFile ? file.oldPath : file.newPath;
}

/** Only paths inside the worktree reach the phone. */
function insideWorktree(path: string): boolean {
  if (!path || posix.isAbsolute(path) || win32.isAbsolute(path)) return false;
  return !path.split(/[\\/]/).includes('..');
}

function statusOf(file: ParsedDiffFile): MobileChangedFile['status'] {
  if (file.isNewFile) return 'added';
  if (file.isDeletedFile) return 'deleted';
  return file.oldPath === file.newPath ? 'modified' : 'renamed';
}

function diffLine(line: string, at: { old: number; new: number }): MobileDiffLine | null {
  const text = line.slice(1);
  if (line.startsWith('+')) return { kind: 'add', text, newNo: at.new++ };
  if (line.startsWith('-')) return { kind: 'del', text, oldNo: at.old++ };
  if (line.startsWith(' ')) return { kind: 'ctx', text, oldNo: at.old++, newNo: at.new++ };
  return null;
}

/** The hunks of one file's diff, each line numbered on the side or sides it exists on. */
export function parseHunks(diffText: string): Hunk[] {
  const hunks: Hunk[] = [];
  const at = { old: 0, new: 0 };
  for (const line of diffText.split('\n')) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      at.old = Number(header[1]);
      at.new = Number(header[2]);
      hunks.push({ header: line, lines: [] });
      continue;
    }
    const parsed = hunks.length ? diffLine(line, at) : null;
    if (parsed) hunks[hunks.length - 1]?.lines.push(parsed);
  }
  return hunks;
}

/** What a value adds to the answer once it is serialized. */
function jsonBytes(value: MobileChatChanges | MobileChangedFile | Hunk[]): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** A file is judged by both its names, so a secret renamed or deleted is still caught. */
function maySecret(file: ParsedDiffFile, worktreePath: string): boolean {
  return [file.oldPath, file.newPath].some(
    (path) => path !== '/dev/null' && isSystemDeniedPath(path, worktreePath),
  );
}

/** Fills one listed file's hunks from what is left of `room`, or says why it has none. */
function withHunks(
  file: ParsedDiffFile,
  entry: MobileChangedFile,
  worktreePath: string,
  room: { bytes: number },
): MobileChangedFile {
  if (file.isBinary) return { ...entry, omitted: 'binary' };
  // The agent's own read deny list (.env, keys, credentials) keeps secrets off the phone too.
  if (maySecret(file, worktreePath)) return { ...entry, omitted: 'secret' };
  // Skips parsing a file whose raw diff alone is larger than the room left.
  if (file.diffText.length > room.bytes) return { ...entry, omitted: 'size' };
  const hunks = parseHunks(file.diffText);
  const bytes = jsonBytes(hunks);
  if (bytes > room.bytes) return { ...entry, omitted: 'size' };
  room.bytes -= bytes;
  return { ...entry, hunks };
}

/** A worktree's uncommitted diff as the phone shows it, cut to `MAX_ANSWER_BYTES`. */
export function projectChatChanges(
  diff: string,
  worktreePath: string,
  summaryOnly = false,
): MobileChatChanges {
  if (diff.length > MAX_DIFF_CHARS) return { ...NO_CHANGES, truncated: true };
  const parsed = splitUnifiedDiffByFile(diff).filter((file) => insideWorktree(pathOf(file)));
  const totals = {
    ...NO_CHANGES,
    additions: parsed.reduce((sum, file) => sum + file.additions, 0),
    deletions: parsed.reduce((sum, file) => sum + file.deletions, 0),
    fileCount: parsed.length,
  };
  if (summaryOnly) return totals;
  const room = { bytes: MAX_ANSWER_BYTES - jsonBytes(totals) };
  const listed: { file: ParsedDiffFile; entry: MobileChangedFile }[] = [];
  for (const file of parsed) {
    const entry: MobileChangedFile = {
      path: pathOf(file),
      status: statusOf(file),
      additions: file.additions,
      deletions: file.deletions,
      hunks: [],
    };
    // The longest note an entry can carry, and the comma between entries.
    const cost = jsonBytes({ ...entry, omitted: 'binary' }) + 1;
    if (cost > room.bytes) break;
    room.bytes -= cost;
    listed.push({ file, entry });
  }
  const files = listed.map(({ file, entry }) => withHunks(file, entry, worktreePath, room));
  const truncated = listed.length < parsed.length || files.some((file) => file.omitted === 'size');
  return { ...totals, files, truncated };
}

type ChangesChat = { worktreePath: string | null; baseBranch: string | null };

/** Read-only: the same git status and diff the desktop's changes panel runs, never a write. */
export async function readChatChanges(
  chat: ChangesChat,
  summaryOnly = false,
  diffOf = getWorktreeDiff,
): Promise<MobileChatChanges> {
  if (!chat.worktreePath) return NO_CHANGES;
  const diff = await diffOf(chat.worktreePath, chat.baseBranch ?? undefined, {
    onlyUncommitted: true,
  });
  // An unreadable worktree must not look clean.
  if (!diff.success) throw new MobileApiError(503, 'Frink could not read these changes.');
  return projectChatChanges(diff.diff ?? '', chat.worktreePath, summaryOnly);
}
