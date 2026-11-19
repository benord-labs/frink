import type { createStore } from 'jotai';
import type * as Monaco from 'monaco-editor';
import {
  activeFileAtom,
  dispatchEditorRevealLine,
  fileKey,
  openFileAtom,
  pinFileAtom,
} from '@/lib/code-editor/state';

type Store = ReturnType<typeof createStore>;

type CodeNavigationOpenerDeps = {
  store: Store;
  getProjectPath: () => string | undefined;
};

/** The parts of Monaco's editor opener this module uses; Monaco's own opener types satisfy it. */
export type CodeNavigationOpener = {
  openCodeEditor(
    source: { getModel(): { uri: { toString(): string } } | null } | null,
    resource: Pick<Monaco.Uri, 'path' | 'toString'>,
    selectionOrPosition?: Monaco.IRange | Monaco.IPosition,
  ): boolean;
};

type MonacoEditorApi = {
  editor: { registerEditorOpener(opener: CodeNavigationOpener): Monaco.IDisposable };
};

type RevealTarget = { lineNumber: number; startColumn: number; endColumn: number };

function revealTarget(selectionOrPosition?: Monaco.IRange | Monaco.IPosition): RevealTarget | null {
  if (!selectionOrPosition) return null;
  if ('lineNumber' in selectionOrPosition) {
    const { lineNumber, column } = selectionOrPosition;
    return { lineNumber, startColumn: column, endColumn: column };
  }
  const { startLineNumber, endLineNumber, startColumn, endColumn } = selectionOrPosition;
  return {
    lineNumber: startLineNumber,
    startColumn,
    endColumn: endLineNumber === startLineNumber ? endColumn : startColumn,
  };
}

function projectRelative(projectPath: string | undefined, targetPath: string): string {
  return projectPath && targetPath.startsWith(`${projectPath}/`)
    ? targetPath.slice(projectPath.length + 1)
    : targetPath;
}

function revealAfterOpen(
  targetPath: string,
  selectionOrPosition?: Monaco.IRange | Monaco.IPosition,
): void {
  const target = revealTarget(selectionOrPosition);
  if (!target) return;
  const { lineNumber, startColumn, endColumn } = target;
  requestAnimationFrame(() =>
    dispatchEditorRevealLine(targetPath, lineNumber, startColumn, endColumn),
  );
}

/**
 * Route cross-file navigation (Cmd+click, Go to Definition) through Frink's tab system.
 * The tab being read is pinned first so the jump never replaces it; the target opens as a preview.
 */
export function registerCodeNavigationOpener(
  monaco: MonacoEditorApi,
  { store, getProjectPath }: CodeNavigationOpenerDeps,
): Monaco.IDisposable {
  return monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selectionOrPosition) {
      const targetPath = resource.path;
      const sourceUri = source?.getModel()?.uri?.toString() ?? 'none';
      if (!targetPath || resource.toString() === sourceUri) return false;
      const projectPath = getProjectPath();
      const relativePath = projectRelative(projectPath, targetPath);

      const sourceFile = store.get(activeFileAtom);
      if (sourceFile) store.set(pinFileAtom, fileKey(sourceFile.path, sourceFile.projectPath));
      store.set(openFileAtom, {
        path: relativePath,
        name: relativePath.split('/').pop() ?? relativePath,
        projectPath,
        sourcePaneIndex: sourceFile?.sourcePaneIndex,
        sourceChatId: sourceFile?.sourceChatId,
        isWorktreeContext: sourceFile?.isWorktreeContext,
        isOtherProject: sourceFile?.isOtherProject,
        intent: 'preview',
      });
      revealAfterOpen(targetPath, selectionOrPosition);
      return true;
    },
  });
}
