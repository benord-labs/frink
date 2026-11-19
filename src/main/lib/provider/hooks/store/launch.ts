import path from 'node:path';
import type { SdkPluginConfig, Settings } from '@anthropic-ai/claude-agent-sdk';
import log from 'electron-log';
import { captureMainException, captureMainMessage } from '../../../sentry/init';
import type { ProviderType } from '../../types';
import { claudeHooksPlugin } from './claude-plugin';
import { cliRunsPluginOnlyHooks, PLUGIN_ONLY_HOOKS, pluginOnlyHooksHold } from './plugin-lock';
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
  // Claude reads none of its hook files under the plugin-only lock, so it is handed them all.
  'claude-code': { scopes: new Set(['user', 'project']) },
  // Codex reads none of Claude's files, so it is handed them all.
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

/** The user's stored hooks this provider must be handed at launch, merged in Claude's order, after
 * bringing the store up to date with the native files. */
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
  // As in Claude's settings merge, the last file that sets the switch decides it.
  const switches = sources.filter((source) => source.disableAllHooks !== undefined);
  if (switches.at(-1)?.disableAllHooks) return { disableAllHooks: true };
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

/** A Claude launch's stored hooks: its flag-layer settings and its SDK options. */
type ClaudeHooksLaunch = {
  settings: LaunchHooks;
  sdkOptions: { plugins?: SdkPluginConfig[]; managedSettings?: Settings };
};

const HOOKS_LOCK_NOTICE =
  "Your organization's Claude settings don't let Frink supply your hooks, so this chat runs the hooks saved in Claude's own settings files instead.";

// A started CLI reported a managed policy dropping the lock: later launches skip it until restart.
let lockDropped = false;
let lockDropReported = false;
/** Per chat, this run: false while the chat is owed the one-line lock notice, true once shown. */
const lockNotices = new Map<string, boolean>();

function noteLockDropped(subChatId: string): void {
  log.warn("[hooks] A managed settings policy drops Frink's hook lock; Claude reads its files");
  if (!lockNotices.has(subChatId)) lockNotices.set(subChatId, false);
  if (lockDropReported) return;
  lockDropReported = true;
  captureMainMessage('Claude hook lock dropped by managed settings', 'warning', {
    surface: 'claude-hooks-lock',
  });
}

/** The one line telling a chat its Claude runs its own hook files, the first time it is asked. */
export function takeHooksLockNotice(subChatId: string): string | null {
  if (lockNotices.get(subChatId) !== false) return null;
  lockNotices.set(subChatId, true);
  return HOOKS_LOCK_NOTICE;
}

/** Every stored hook as one Frink plugin, under the lock that makes Claude read no hook file; else,
 * or when Claude refuses the plugin, Claude reads its own files plus the user's hooks. */
export async function claudeHooksForLaunch(
  projectRoot: string | null,
  subChatId: string,
  claudeBinary: string,
): Promise<ClaudeHooksLaunch> {
  try {
    if (!lockDropped && (await pluginOnlyHooksHold())) {
      // The switch also stops the hooks of Claude plugins Frink installs.
      const { hooks, ...settings } = await hooksForLaunch('claude-code', projectRoot);
      const plugin = hooks ? await claudeHooksPlugin(hooks, claudeBinary) : undefined;
      if (plugin !== null) {
        const plugins = plugin ? [{ type: 'local' as const, path: plugin }] : undefined;
        return {
          settings,
          sdkOptions: { ...(plugins && { plugins }), managedSettings: PLUGIN_ONLY_HOOKS },
        };
      }
      // As outside Frink, a file Claude cannot load costs only that file's hooks.
      log.warn('[hooks] Claude refuses a stored hook file; it reads its own files instead');
    } else {
      noteLockDropped(subChatId);
    }
  } catch (error) {
    log.warn('[hooks] Could not hand Claude its hooks as a plugin; Claude reads its files', error);
    captureMainException(error, { surface: 'claude-hooks-plugin' });
  }
  return { settings: await hooksForLaunch('claude-code', null), sdkOptions: {} };
}

/** Asks a CLI launched under the lock whether it runs under it: only the CLI sees an org's
 * server-managed settings. If not, later launches skip the lock. Never rejects. */
export async function checkClaudeHooksLock(
  query: Parameters<typeof cliRunsPluginOnlyHooks>[0],
  subChatId: string,
): Promise<void> {
  if ((await cliRunsPluginOnlyHooks(query)) !== false) return;
  lockDropped = true;
  noteLockDropped(subChatId);
}

export function _resetHooksLockForTests(): void {
  lockDropped = false;
  lockDropReported = false;
  lockNotices.clear();
}
