export function deriveProjectPathFromEditorPath(
  pathForEditor: string,
  displayPath: string,
  worktreePath: string | null | undefined,
): string | undefined {
  if (worktreePath) return worktreePath;
  if (!pathForEditor.endsWith(displayPath)) return undefined;
  return pathForEditor.slice(0, -(displayPath.length + 1));
}

type BuildAgentEditorOpenInputArgs = {
  pathForEditor: string | null;
  displayPath: string | null;
  worktreePath: string | null | undefined;
  filename: string;
  chatId: string | null | undefined;
};

export function buildAgentEditorOpenInput({
  pathForEditor,
  displayPath,
  worktreePath,
  filename,
  chatId,
}: BuildAgentEditorOpenInputArgs): {
  path: string;
  name: string;
  projectPath: string | undefined;
  isWorktreeContext: boolean;
  sourceChatId: string | undefined;
  intent: 'pinned';
} | null {
  if (!pathForEditor || !displayPath) return null;

  const derivedProjectPath = deriveProjectPathFromEditorPath(
    pathForEditor,
    displayPath,
    worktreePath,
  );

  return {
    path: derivedProjectPath ? displayPath : pathForEditor,
    name: filename,
    projectPath: derivedProjectPath,
    isWorktreeContext: Boolean(worktreePath),
    sourceChatId: chatId ?? undefined,
    intent: 'pinned',
  };
}
