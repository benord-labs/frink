// Go to definition for imports and aliases: Monaco's TS worker only sees files loaded as models, so
// the main process resolves the import and returns the exact declaration (file top for assets).

import type * as Monaco from 'monaco-editor';
import { encodeFileUri } from '@/lib/code-editor/files';
import { trpcClient } from '@/lib/trpc';
import { openTabBuffers, resolveAliasDefinition } from './resolve-alias-definition';

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

export function registerAliasDefinitionProvider(
  monaco: typeof Monaco,
  projectPath: string,
): Monaco.IDisposable {
  return monaco.languages.registerDefinitionProvider(SUPPORTED_LANGUAGES, {
    async provideDefinition(model, position, token) {
      const found = await resolveAliasDefinition(
        model,
        position,
        token,
        projectPath,
        (input) => trpcClient.files.resolveDefinition.query(input),
        openTabBuffers,
      );
      return found && { uri: monaco.Uri.parse(encodeFileUri(found.path)), range: found.range };
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
