import { useSetAtom, useStore } from 'jotai';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { isWindowsAbsolutePath } from '../../../../shared/lib/path-normalization';
import { trpc } from '../../trpc';
import { fileKey, markFileSavedAtom, openFilesAtom } from '../state/atoms';
import { getFullPath } from './model-path';

export type SaveOpenFile = (key: string) => Promise<boolean>;

/**
 * Writes an open tab to disk by its key; resolves true once it is saved. A tab without its own
 * project resolves against `fallbackProjectPath`; `onSavedInProject` refreshes that project's tree.
 */
export function useSaveOpenFile(
  fallbackProjectPath: string | undefined,
  onSavedInProject: (projectPath: string) => void,
): SaveOpenFile {
  const store = useStore();
  const markFileSaved = useSetAtom(markFileSavedAtom);
  const utils = trpc.useUtils();

  return useCallback(
    async (key: string) => {
      const find = () =>
        store.get(openFilesAtom).find((f) => fileKey(f.path, f.projectPath) === key);
      const file = find();
      if (file?.content === undefined) return false;
      // A kept tab from another project never borrows the selected project's folder.
      const projectPath =
        file.projectPath ?? (file.isOtherProject ? undefined : fallbackProjectPath);
      if (!projectPath && !file.path.startsWith('/') && !isWindowsAbsolutePath(file.path)) {
        toast.error("Couldn't save: this file's folder is unknown");
        return false;
      }
      try {
        await utils.client.files.writeFile.mutate({
          filePath: getFullPath(projectPath, file.path),
          content: file.content,
        });
      } catch {
        toast.error('Failed to save file');
        return false;
      }
      // An edit typed while the write ran is not on disk yet, so the tab stays unsaved.
      const unchanged = find()?.content === file.content;
      if (unchanged) markFileSaved(key);
      utils.files.listDirectory.invalidate();
      utils.files.symlinkEscape.invalidate();
      // Git status is worktree-scoped — a file outside any project has none to refresh.
      if (projectPath) {
        const target = { worktreePath: projectPath, filePath: file.path };
        utils.changes.getStatus.invalidate({ worktreePath: projectPath });
        utils.changes.getWorkingFileLineChanges.invalidate(target);
        utils.changes.getOriginalContent.invalidate(target);
        onSavedInProject(projectPath);
      }
      return unchanged;
    },
    [store, fallbackProjectPath, onSavedInProject, markFileSaved, utils],
  );
}
