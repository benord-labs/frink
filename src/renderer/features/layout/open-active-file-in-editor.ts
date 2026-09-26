import { toast } from 'sonner';
import { getDecodedBasename } from '../../lib/get-decoded-basename';

type ActiveFileEntry = {
  path?: string;
  projectPath?: string;
};

type OpenInEditorResult = { success: boolean; error?: string };
type OpenInEditorMutate = (input: { path: string; cwd?: string }) => Promise<OpenInEditorResult>;

async function openInEditor(
  filePath: string,
  cwd: string | undefined,
  mutate: OpenInEditorMutate,
): Promise<void> {
  const fileName = getDecodedBasename(filePath);
  toast.info(`Opening ${fileName} in editor…`);
  try {
    const result = await mutate({ path: filePath, cwd });
    if (!result.success) {
      toast.error(`Couldn't open ${fileName} in an editor`, { description: result.error });
    }
  } catch (error) {
    toast.error(`Couldn't open ${fileName} in an editor`, {
      description: error instanceof Error ? error.message : undefined,
    });
  }
}

/**
 * Opens the currently active file in the external editor.
 * Falls back to the most recently opened file when no code-editor file is active.
 */
export async function openActiveFileInEditor(
  activeFile: ActiveFileEntry | null,
  recentFiles: string[],
  fallbackCwd: string | undefined,
  mutate: OpenInEditorMutate,
): Promise<void> {
  const filePath = activeFile?.path;

  if (filePath) {
    await openInEditor(filePath, activeFile?.projectPath ?? fallbackCwd, mutate);
    return;
  }

  if (recentFiles.length > 0) {
    await openInEditor(recentFiles[0], fallbackCwd, mutate);
    return;
  }

  toast.info('No file to open — open a file first');
}
