import type {
  MobileActivity,
  MobileChangedFile,
  MobileChatChanges,
  MobileDiffLine,
} from '@frink/shared/types/remote/mobile';

export type DiffRow =
  | { type: 'hunk'; key: string; text: string }
  | { type: 'line'; key: string; line: MobileDiffLine };

/** The header's count, such as "+38 −12": changes with no lines to count read as "Changes". */
export function changeCount(changes: MobileChatChanges | undefined): string | null {
  if (!changes) return null;
  if (changes.additions + changes.deletions > 0)
    return `+${changes.additions} −${changes.deletions}`;
  return changes.fileCount > 0 || changes.truncated ? 'Changes' : null;
}

export type TurnCount = { activity: MobileActivity | undefined; ended: number };

/** Counts turns that stop running: each may have changed files, so it is worth a fresh count. */
export function countTurnEnd(turns: TurnCount, activity: MobileActivity | undefined): TurnCount {
  if (turns.activity === activity) return turns;
  return { activity, ended: turns.ended + Number(turns.activity === 'running') };
}

/** Names a line the way an agent can find it; a removed line says so, since its number is the old file's. */
export function lineLocation(path: string, line: MobileDiffLine): string {
  return line.newNo === undefined
    ? `${path} (removed line ${line.oldNo})`
    : `${path}:${line.newNo}`;
}

/** Starts a new line in a half-written draft rather than replacing it. */
export function withReference(draft: string, reference: string): string {
  const kept = draft.trimEnd();
  return kept ? `${kept}\n${reference}` : reference;
}

/** One file's hunks as flat list rows, keyed by position so a row never changes identity. */
export function diffRows(file: MobileChangedFile): DiffRow[] {
  return file.hunks.flatMap((hunk, h): DiffRow[] => [
    { type: 'hunk', key: `${file.path}:${h}`, text: hunk.header },
    ...hunk.lines.map((line, l): DiffRow => ({
      type: 'line',
      key: `${file.path}:${h}:${l}`,
      line,
    })),
  ]);
}

/** One list section per file; a closed file keeps its header and hides its rows. */
export function fileSections(files: MobileChangedFile[], closed: ReadonlySet<string>) {
  return files.map((file) => ({
    key: file.path,
    file,
    data: closed.has(file.path) ? [] : diffRows(file),
  }));
}

/** `closed` with `path` opened if it was closed, or closed if it was open. */
export function toggled(closed: ReadonlySet<string>, path: string): ReadonlySet<string> {
  const next = new Set(closed);
  if (!next.delete(path)) next.add(path);
  return next;
}

export const OMITTED_NOTE: Record<NonNullable<MobileChangedFile['omitted']>, string> = {
  binary: 'Binary file.',
  secret: 'Hidden because it may hold secrets. Open it on your computer.',
  size: 'Too large to show here. Open it on your computer.',
};

/** The list's opening line, such as "3 files · +38 −12", or nothing when no file changed. */
export function changeSummary(changes: MobileChatChanges | undefined): string | null {
  if (!changes?.fileCount) return null;
  const files = changes.fileCount === 1 ? 'file' : 'files';
  return `${changes.fileCount} ${files} · +${changes.additions} −${changes.deletions}`;
}

/** What an empty list shows: a spinner while asking, "No changes" for a clean worktree. */
export function emptyKind(
  changes: MobileChatChanges | undefined,
  error: string | undefined,
): 'loading' | 'clean' | null {
  if (error !== undefined) return null;
  if (!changes) return 'loading';
  return changes.truncated ? null : 'clean';
}

/** Why an open file shows no lines, or nothing when its lines are shown or it is closed. */
export function omittedNote(file: MobileChangedFile, open: boolean): string | null {
  return open && file.omitted ? OMITTED_NOTE[file.omitted] : null;
}
