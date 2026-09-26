/**
 * Project Type Loader for Monaco Editor
 *
 * Loads TypeScript/JavaScript files from the project into Monaco's
 * TypeScript worker via addExtraLib, enabling type inference and
 * definition resolution for local imports.
 *
 * We intentionally do NOT call createModel for project files — doing so
 * for hundreds of files triggers Monaco's listener leak detector (500 cap).
 * Instead, addExtraLib provides type info to the TS worker, and our
 * registerEditorOpener handles the actual cross-file navigation.
 *
 * Alias resolution (e.g. @/*) is handled by alias-definition-provider.ts.
 */

import type * as Monaco from 'monaco-editor';
import { encodeFileUri } from '@/lib/code-editor/files';
import { trpcClient } from '@/lib/trpc';

let loadedProjectPath: string | null = null;
let loadedFileCount = 0;

export async function loadProjectTypes(
  monaco: typeof Monaco,
  projectPath: string,
): Promise<number> {
  if (loadedProjectPath === projectPath && loadedFileCount > 0) {
    return loadedFileCount;
  }

  try {
    const result = await trpcClient.files.getProjectTypeFiles.query({
      projectPath,
      maxFileSize: 100000,
    });

    const ts = monaco.typescript.typescriptDefaults;
    const js = monaco.typescript.javascriptDefaults;

    for (const file of result.files) {
      const uriStr = encodeFileUri(`${projectPath}/${file.path}`);
      ts.addExtraLib(file.content, uriStr);
      js.addExtraLib(file.content, uriStr);
    }

    loadedProjectPath = projectPath;
    loadedFileCount = result.files.length;
    return loadedFileCount;
  } catch {
    return 0;
  }
}

export function clearProjectTypes(): void {
  loadedProjectPath = null;
  loadedFileCount = 0;
}
