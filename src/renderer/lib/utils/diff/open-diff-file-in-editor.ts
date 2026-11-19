import { getFullPath } from '@/lib/code-editor/files';
import { dispatchEditorRevealLine } from '@/lib/code-editor/state';
import { buildOpenWorktreeFileInput } from '@/lib/worktree/open-worktree-file-in-editor';
import { getFirstChangedLine, type RenderableDiffFile } from './diff-code-view-items';

type OpenWorktreeFileInput = NonNullable<ReturnType<typeof buildOpenWorktreeFileInput>>;

type OpenDiffFileInEditor = {
  /** The clicked header's title, which is its parsed diff's name. */
  filePath: string;
  files: readonly RenderableDiffFile[];
  worktreePath: string | null | undefined;
  chatId: string;
  openFile: (input: OpenWorktreeFileInput) => void;
};

/** Opens a diff-panel file in the editor, scrolled to its first changed line. */
export function openDiffFileInEditor({
  filePath,
  files,
  worktreePath,
  chatId,
  openFile,
}: OpenDiffFileInEditor): void {
  const input = buildOpenWorktreeFileInput({ filePath, worktreePath, chatId });
  if (!input) return;
  openFile(input);
  const file = files.find((candidate) => candidate.fileDiff.name === filePath);
  const line = file ? getFirstChangedLine(file.fileDiff) : null;
  if (line === null) return;
  const absolutePath = getFullPath(input.projectPath, input.path);
  requestAnimationFrame(() => dispatchEditorRevealLine(absolutePath, line));
}
