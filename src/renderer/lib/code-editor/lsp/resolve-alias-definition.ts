import type * as Monaco from 'monaco-editor';
import { extractQuotedStringAtPosition, getFullPath } from '@/lib/code-editor/files';
import { type OpenFile, openFilesAtom } from '@/lib/code-editor/state';
import { appStore } from '@/lib/jotai-store';
import { isWindowsAbsolutePath } from '../../../../shared/lib/path-normalization';

const TS_LANGUAGES = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);
const SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/;
// Measured in UTF-16 units, a lower bound on UTF-8 bytes; main enforces its 2 MB byte cap itself.
const MAX_BUFFER_CHARS = 2 * 1024 * 1024;
const MAX_TOTAL_CHARS = 8 * 1024 * 1024;
const MAX_BUFFERS = 20;

/** The members of Monaco's text model this lookup reads. */
export type AliasDefinitionModel = {
  uri: { path: string };
  getLanguageId(): string;
  getLineContent(lineNumber: number): string;
  getValue(): string;
  getOffsetAt(position: Monaco.IPosition): number;
};

/** Unsaved text by absolute path; `null` marks a tab too large to send, which main opens at its
 * top rather than reading the out-of-date disk copy. */
type OpenBuffers = Record<string, string | null>;

type DefinitionQuery = {
  projectPath: string;
  containingFile: string;
  fileContent?: string;
  offset?: number;
  specifier?: string;
  openBuffers?: OpenBuffers;
};

type DefinitionReply = { path: string; line: number; column: number; endColumn: number } | null;

export type QueryDefinition = (input: DefinitionQuery) => Promise<DefinitionReply>;

function absolutePathOf(file: OpenFile): string | null {
  // A kept tab with a relative path and no folder belongs to no known project: never guess one.
  const path = getFullPath(file.projectPath, file.path);
  return path.startsWith('/') || isWindowsAbsolutePath(path) ? path : null;
}

/** Unsaved JS/TS tabs other than `clickedPath` by absolute path. Text past the caps is sent as
 * `null`, so a large unsaved file neither blocks the request nor falls back to disk. */
export function collectOpenBuffers(files: readonly OpenFile[], clickedPath?: string): OpenBuffers {
  const buffers: OpenBuffers = {};
  let count = 0;
  let total = 0;
  for (const file of files) {
    const content = file.content;
    if (!file.isDirty || content === undefined || !SOURCE_FILE_PATTERN.test(file.path)) continue;
    const path = absolutePathOf(file);
    if (!path || path === clickedPath) continue;
    const fits =
      count < MAX_BUFFERS &&
      content.length <= MAX_BUFFER_CHARS &&
      total + content.length <= MAX_TOTAL_CHARS;
    buffers[path] = fits ? content : null;
    if (!fits) continue;
    count += 1;
    total += content.length;
  }
  return buffers;
}

/** The editor's unsaved tabs, for {@link resolveAliasDefinition}'s `getOpenBuffers`. */
export function openTabBuffers(clickedPath: string): OpenBuffers {
  return collectOpenBuffers(appStore.get(openFilesAtom), clickedPath);
}

/** Asks the main process where the import or specifier under the cursor is defined. */
export async function resolveAliasDefinition(
  model: AliasDefinitionModel,
  position: Monaco.IPosition,
  token: Pick<Monaco.CancellationToken, 'isCancellationRequested'>,
  projectPath: string,
  queryDefinition: QueryDefinition,
  getOpenBuffers?: (clickedPath: string) => OpenBuffers,
): Promise<{ path: string; range: Monaco.IRange } | null> {
  const line = model.getLineContent(position.lineNumber);
  const isTS = TS_LANGUAGES.has(model.getLanguageId());
  const quotedString = extractQuotedStringAtPosition(line, position.column);
  if (token.isCancellationRequested) return null;

  try {
    const resolved = await queryDefinition({
      projectPath,
      // Monaco's Uri.path is already decoded; decoding again breaks names containing '%'.
      containingFile: model.uri.path,
      // Live buffers travel with every request: the main process keeps no copy of unsaved edits.
      fileContent: isTS ? model.getValue() : undefined,
      offset: isTS ? model.getOffsetAt(position) : undefined,
      specifier: quotedString ?? undefined,
      openBuffers: isTS ? getOpenBuffers?.(model.uri.path) : undefined,
    });
    if (!resolved || token.isCancellationRequested) return null;
    return {
      path: resolved.path,
      range: {
        startLineNumber: resolved.line,
        startColumn: resolved.column,
        endLineNumber: resolved.line,
        endColumn: resolved.endColumn,
      },
    };
  } catch {
    return null;
  }
}
