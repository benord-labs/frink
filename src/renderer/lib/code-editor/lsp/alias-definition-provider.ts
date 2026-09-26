/**
 * Universal definition provider for path aliases across all languages.
 *
 * Monaco's standalone TS worker does NOT support tsconfig `paths`
 * (upstream issue microsoft/monaco-editor#1926). This provider
 * delegates to the main process which uses TypeScript's own parser
 * and module resolver, with a filesystem fallback for non-TS assets
 * (.scss, .css, .json, .svg, etc.).
 */

import type * as Monaco from 'monaco-editor';
import { encodeFileUri, extractQuotedStringAtPosition } from '@/lib/code-editor/files';
import { trpcClient } from '@/lib/trpc';

const SUPPORTED_LANGUAGES = [
  'typescript',
  'typescriptreact',
  'javascript',
  'javascriptreact',
  'css',
  'scss',
  'less',
  'sass',
  'json',
  'jsonc',
  'html',
];

const TS_LANGUAGES = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);

export function registerAliasDefinitionProvider(
  monaco: typeof Monaco,
  projectPath: string,
): Monaco.IDisposable {
  return monaco.languages.registerDefinitionProvider(SUPPORTED_LANGUAGES, {
    async provideDefinition(model, position) {
      const word = model.getWordAtPosition(position);
      const line = model.getLineContent(position.lineNumber);
      const containingFile = decodeURIComponent(model.uri.path);
      const lang = model.getLanguageId();
      const isTS = TS_LANGUAGES.has(lang);

      const quotedString = extractQuotedStringAtPosition(line, position.column);
      const symbolName = isTS && word ? word.word : undefined;
      // Always send the live buffer for TS/JS. A version-id cache avoided resending unchanged
      // files but could skip content when the main-process view was stale or reset (reconnect,
      // errors) while the editor model still matched the last cached version id.
      const fileContent = isTS ? model.getValue() : undefined;

      try {
        const resolved = await trpcClient.files.resolveDefinition.query({
          projectPath,
          containingFile,
          symbolName,
          fileContent,
          specifier: quotedString ?? undefined,
        });

        if (!resolved) return null;

        const targetUri = monaco.Uri.parse(encodeFileUri(resolved));
        return {
          uri: targetUri,
          range: new monaco.Range(1, 1, 1, 1),
        };
      } catch {
        return null;
      }
    },
  });
}

let warnedClearAliasCacheDeprecated = false;

/**
 * Previously used when a version-id cache existed for definition requests.
 *
 * @deprecated No-op: Go to definition always sends the live buffer via
 *   {@link monaco.editor.ITextModel.getValue | model.getValue()} (see `provideDefinition`); there is
 *   no separate alias cache to clear. Invoking this is unnecessary; it remains only for any
 *   legacy teardown hooks.
 */
export function clearAliasCache(): void {
  if (!warnedClearAliasCacheDeprecated) {
    warnedClearAliasCacheDeprecated = true;
    // biome-ignore lint/suspicious/noConsole: One-time deprecation notice for legacy teardown callers
    console.warn(
      '[alias-definition-provider] clearAliasCache() is deprecated and has no effect (definitions use model.getValue()).',
    );
  }
}
