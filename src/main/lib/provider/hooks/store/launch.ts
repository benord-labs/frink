import path from 'node:path';
import type { Settings } from '@anthropic-ai/claude-agent-sdk';
import type { ProviderType } from '../../types';
import { type StoredHookSource, syncHookStore } from './store';

type Hooks = NonNullable<Settings['hooks']>;
/** The stored hooks one launch carries, in Claude's settings shape, which Codex's format copies. */
export type LaunchHooks = { hooks?: Hooks; disableAllHooks?: true };

/** How a provider takes stored hooks at launch. A provider Frink adds is one row here. */
type HookAdapter = {
  /** The scopes the provider does not already load from the user's own files. */
  scopes: ReadonlySet<StoredHookSource['scope']>;
};

const HOOK_ADAPTERS = {
  // Claude loads a project's hooks itself; its per-chat config folder hides only the user's.
  'claude-code': { scopes: new Set(['user']) },
  // Codex reads none of Claude's files, so it is handed the project's uncommitted hooks too.
  codex: { scopes: new Set(['user', 'project']) },
} satisfies Partial<Record<ProviderType, HookAdapter>>;

function hookAdapter(provider: ProviderType): HookAdapter | undefined {
  // SAFETY: the `in` guard proves provider is a key of the literal HOOK_ADAPTERS.
  return provider in HOOK_ADAPTERS
    ? HOOK_ADAPTERS[provider as keyof typeof HOOK_ADAPTERS]
    : undefined;
}

/** Claude's order: user settings, then the project's `settings.json`, then `settings.local.json`. */
function claudeOrder([file, source]: [string, StoredHookSource]): number {
  if (source.scope === 'user') return 0;
  return path.basename(file) === 'settings.local.json' ? 2 : 1;
}

function appliesTo(source: StoredHookSource, adapter: HookAdapter, projectRoot: string | null) {
  if (!adapter.scopes.has(source.scope)) return false;
  return source.scope === 'user' || source.projectRoot === projectRoot;
}

/** The user's stored hooks this provider must be handed at launch, after bringing the store up to
 * date with the native files. User hooks come first, then the project's, as Claude orders them. */
export async function hooksForLaunch(
  provider: ProviderType,
  projectRoot: string | null,
): Promise<LaunchHooks> {
  const store = await syncHookStore(projectRoot);
  const adapter = hookAdapter(provider);
  if (!adapter) return {};
  const sources = Object.entries(store.sources)
    .filter(([, source]) => appliesTo(source, adapter, projectRoot))
    .sort((a, b) => claudeOrder(a) - claudeOrder(b))
    .map(([, source]) => source);
  if (sources.some((source) => source.disableAllHooks)) return { disableAllHooks: true };
  // A Map, so an event named like an Object.prototype member is just another key.
  const hooks = new Map<string, Hooks[string]>();
  for (const source of sources) {
    for (const [event, groups] of Object.entries(source.hooks)) {
      // SAFETY: stored groups were parsed from a Claude settings file's `hooks` key.
      const typed = groups as Hooks[string];
      hooks.set(event, [...(hooks.get(event) ?? []), ...typed]);
    }
  }
  return hooks.size > 0 ? { hooks: Object.fromEntries(hooks) } : {};
}
