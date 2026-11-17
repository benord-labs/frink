import { useSetAtom } from 'jotai';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { getFullPath } from '@/lib/code-editor/files';
import { dispatchEditorRevealLine, openFileAtom } from '@/lib/code-editor/state';
import { trpc } from '@/lib/trpc';
import {
  type FileLinkOpenInput,
  type FileLinkTarget,
  findShortenedPath,
  isBareRelativePath,
} from './file-link-target';

// A click reads the project as it is now, never an answer kept from an earlier click.
const FRESH = { staleTime: 0 };

/** Opens a referenced file in the editor at its line, once the disk shows a file there.
 * `sourcePaneIndex` is the split-view pane the click came from, which the tab then belongs to. */
export function useOpenFileLink(
  sourcePaneIndex?: number,
): (input: FileLinkOpenInput, target: FileLinkTarget) => Promise<void> {
  const utils = trpc.useUtils();
  const openFile = useSetAtom(openFileAtom);
  return useCallback(
    async (input, target) => {
      const { projectPath } = input;
      const typeAt = (relativePath: string) =>
        utils.files.entryType.fetch({ projectPath, relativePath }, FRESH);
      let { path } = input;
      let type = await typeAt(path);
      // Only a bare relative path can be a shortened one. The search proposes; the disk decides.
      if (!type && isBareRelativePath(target.path)) {
        const entries = await utils.files.search.fetch({ projectPath, query: path }, FRESH);
        path = findShortenedPath(path, entries) ?? path;
        if (path !== input.path) type = await typeAt(path);
      }
      if (type === 'folder') return;
      if (!type) {
        toast.error(`Couldn't find ${input.name} in this project`);
        return;
      }
      openFile({ ...input, path, sourcePaneIndex });
      const filePath = getFullPath(projectPath, path);
      const { line } = target;
      if (line) requestAnimationFrame(() => dispatchEditorRevealLine(filePath, line));
    },
    [utils, openFile, sourcePaneIndex],
  );
}
