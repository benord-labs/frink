import * as Sentry from '@sentry/electron/renderer';
import type * as Monaco from 'monaco-editor';
import { loadLanguage } from '@/lib/themes/shiki-theme-loader';
import { shikiLanguageFor } from './language-map';
import { createShikiTokensProvider } from './tokens-provider';

/** A registered language; Monaco's own definitions carry a loader for their Monarch grammar. */
type LanguageEntry = Monaco.languages.ILanguageExtensionPoint & {
  loader?: () => Promise<{ language: Monaco.languages.IMonarchLanguage }>;
};

type Options = {
  load?: typeof loadLanguage;
  report?: typeof Sentry.captureException;
};

/**
 * Tokenizes every language Shiki has a grammar for with that grammar, loaded on first use. Monaco
 * keeps its own tokenizer for the rest, and for any language whose grammar fails to load.
 */
export function registerShikiTokenizers(
  monaco: typeof Monaco,
  { load = loadLanguage, report = Sentry.captureException }: Options = {},
) {
  const { jsonDefaults } = monaco.json;
  // JSON mode sets its own tokenizer directly, which would always win over a factory.
  const setJsonTokens = (tokens: boolean) =>
    jsonDefaults.setModeConfiguration({ ...jsonDefaults.modeConfiguration, tokens });
  setJsonTokens(false);

  const entries = new Map<string, LanguageEntry>();
  // SAFETY: LanguageEntry only adds an optional `loader`, which Monaco's own definitions register.
  for (const entry of monaco.languages.getLanguages() as LanguageEntry[]) {
    entries.set(entry.id, { ...entries.get(entry.id), ...entry });
  }

  for (const [id, entry] of entries) {
    const shikiId = shikiLanguageFor(id);
    if (!shikiId) continue;
    monaco.languages.registerTokensProviderFactory(id, {
      create: async () => {
        try {
          const highlighter = await load(shikiId);
          return createShikiTokensProvider(highlighter, highlighter.getLanguage(shikiId));
        } catch (error) {
          report(error, { tags: { surface: 'monaco-tokenizer', language: id } });
          if (id === 'json') {
            setJsonTokens(true);
            return null;
          }
          // A fallback that cannot load either leaves the language plain, as Monaco would alone.
          const fallback = await entry.loader?.().catch(() => undefined);
          return fallback?.language ?? null;
        }
      },
    });
  }

  // Monaco resolves a language's tokenizer once, for its first model, so resolve open ones again.
  for (const id of new Set(monaco.editor.getModels().map((model) => model.getLanguageId()))) {
    if (shikiLanguageFor(id)) monaco.editor.tokenize('', id);
  }
}
