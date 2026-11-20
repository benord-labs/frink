import { useSetAtom } from 'jotai';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { getFullPath } from '@/lib/code-editor/files';
import { dispatchEditorRevealLine, openFileAtom } from '@/lib/code-editor/state';
import { trpc } from '@/lib/trpc';
import {
  type FileLinkOpenInput,
  type FileLinkTarget,
  resolveFileLinkClick,
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
    async ({ projectName, ...input }, target) => {
      const { projectPath } = input;
      const click = await resolveFileLinkClick(input, target, projectName, {
        typeAt: (relativePath) => utils.files.entryType.fetch({ projectPath, relativePath }, FRESH),
        search: (query) => utils.files.search.fetch({ projectPath, query }, FRESH),
      });
      if (!click) return;
      if ('problem' in click) {
        toast.error(click.problem);
        return;
      }
      const path = click.open;
      openFile({ ...input, path, sourcePaneIndex });
      const filePath = getFullPath(projectPath, path);
      const { line } = target;
      if (line) requestAnimationFrame(() => dispatchEditorRevealLine(filePath, line));
    },
    [utils, openFile, sourcePaneIndex],
  );
}
