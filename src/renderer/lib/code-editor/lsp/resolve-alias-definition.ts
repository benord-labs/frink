import type * as Monaco from 'monaco-editor';
import { extractQuotedStringAtPosition } from '@/lib/code-editor/files';

const TS_LANGUAGES = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);

/** The members of Monaco's text model this lookup reads. */
export type AliasDefinitionModel = {
  uri: { path: string };
  getLanguageId(): string;
  getLineContent(lineNumber: number): string;
  getValue(): string;
  getOffsetAt(position: Monaco.IPosition): number;
};

type DefinitionQuery = {
  projectPath: string;
  containingFile: string;
  fileContent?: string;
  offset?: number;
  specifier?: string;
};

type DefinitionReply = { path: string; line: number; column: number; endColumn: number } | null;

export type QueryDefinition = (input: DefinitionQuery) => Promise<DefinitionReply>;

/** Asks the main process where the import or specifier under the cursor is defined. */
export async function resolveAliasDefinition(
  model: AliasDefinitionModel,
  position: Monaco.IPosition,
  token: Pick<Monaco.CancellationToken, 'isCancellationRequested'>,
  projectPath: string,
  queryDefinition: QueryDefinition,
): Promise<{ path: string; range: Monaco.IRange } | null> {
  const line = model.getLineContent(position.lineNumber);
  const isTS = TS_LANGUAGES.has(model.getLanguageId());
  const quotedString = extractQuotedStringAtPosition(line, position.column);

  try {
    const resolved = await queryDefinition({
      projectPath,
      containingFile: decodeURIComponent(model.uri.path),
      // Always the live buffer: the main process keeps no copy of unsaved edits.
      fileContent: isTS ? model.getValue() : undefined,
      offset: isTS ? model.getOffsetAt(position) : undefined,
      specifier: quotedString ?? undefined,
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
