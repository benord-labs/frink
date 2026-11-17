import { createHash } from 'node:crypto';
import stableStringify from 'fast-json-stable-stringify';
import { z } from 'zod';
import type { LaunchHooks } from '../../../provider/hooks/store';

type ClaudeGroup = NonNullable<LaunchHooks['hooks']>[string][number];

/** Codex's hook events and the label it keys and hashes each by (codex-rs hooks/src/lib.rs). */
const CODEX_EVENT_LABELS = new Map([
  ['PreToolUse', 'pre_tool_use'],
  ['PermissionRequest', 'permission_request'],
  ['PostToolUse', 'post_tool_use'],
  ['PreCompact', 'pre_compact'],
  ['PostCompact', 'post_compact'],
  ['SessionStart', 'session_start'],
  ['SessionEnd', 'session_end'],
  ['UserPromptSubmit', 'user_prompt_submit'],
  ['SubagentStart', 'subagent_start'],
  ['SubagentStop', 'subagent_stop'],
  ['Stop', 'stop'],
  ['Interrupt', 'interrupt'],
]);
/** Events whose matcher Codex ignores, so it is left out of the trust hash. */
const MATCHERLESS_EVENTS = new Set(['UserPromptSubmit', 'Stop', 'Interrupt']);
/** The source Codex names hooks from thread/start `config` by in their trust keys. */
const SESSION_FLAGS_SOURCE = '/<session-flags>/config.toml';

/** A Claude command hook Codex runs as written. Any other field (such as `if`, exec `args`,
 * `asyncRewake` or PowerShell), or a malformed one, changes how it runs, so the hook is refused. */
const CommandHandler = z
  .strictObject({
    type: z.literal('command'),
    command: z.string(),
    timeout: z
      .number()
      .nonnegative()
      .transform((seconds) => Math.ceil(seconds))
      .optional(),
    async: z.boolean().optional(),
    statusMessage: z.string().optional(),
    shell: z.enum(['bash']).optional(),
    once: z.literal(false).optional(),
  })
  .transform(({ type, command, timeout, async, statusMessage }) => ({
    type,
    command,
    ...(timeout !== undefined && { timeout }),
    ...(async !== undefined && { async }),
    ...(statusMessage !== undefined && { statusMessage }),
  }));
type CommandHandler = z.infer<typeof CommandHandler>;

/** Frink's own hook for a Codex thread: a call to one of its MCP tools. */
type FrinkHandler = {
  type: 'mcp_tool';
  server: string;
  tool: string;
  input: { stop_hook_active: string };
  timeout: number;
};
type CodexGroup = { matcher?: string; hooks: Array<CommandHandler | FrinkHandler> };
type HookTrust = { trusted_hash: string; enabled: true };

/** Codex's timeout after its own defaults and clamps, which the trust hash covers. */
function codexTimeout(event: string, timeout: number | undefined): number {
  if (event === 'SessionEnd' || event === 'Interrupt')
    return Math.min(Math.max(timeout ?? 1, 1), 3);
  return Math.max(timeout ?? 600, 1);
}

/** The hash Codex trusts a handler by: sha256 of its key-sorted normalized identity. */
function codexTrustedHash(event: string, matcher: string | undefined, hook: CommandHandler) {
  const handler = {
    type: 'command',
    command: hook.command,
    timeout: codexTimeout(event, hook.timeout),
    async: hook.async ?? false,
    ...(hook.statusMessage !== undefined && { statusMessage: hook.statusMessage }),
  };
  const identity = {
    event_name: CODEX_EVENT_LABELS.get(event),
    hooks: [handler],
    ...(!MATCHERLESS_EVENTS.has(event) && matcher !== undefined && { matcher }),
  };
  return `sha256:${createHash('sha256').update(stableStringify(identity)).digest('hex')}`;
}

/** The command handlers of a Claude matcher group that Codex can run. */
function commandHandlers(group: ClaudeGroup): CommandHandler[] {
  return group.hooks.flatMap((hook) => {
    const parsed = CommandHandler.safeParse(hook);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * The `hooks` table of a Codex thread config: Frink's own groups, then the user's Claude hooks
 * that Codex can run, each marked trusted under the key Codex derives from its position.
 */
export function codexThreadHooks(
  userHooks: LaunchHooks['hooks'],
  frinkHooks: { Stop?: CodexGroup[] } = {},
) {
  const events = new Map<string, CodexGroup[]>(Object.entries(frinkHooks));
  const state = new Map<string, HookTrust>();
  for (const [event, groups] of Object.entries(userHooks ?? {})) {
    const label = CODEX_EVENT_LABELS.get(event);
    if (!label) continue;
    for (const group of groups) {
      const handlers = commandHandlers(group);
      if (handlers.length === 0) continue;
      const delivered = events.get(event) ?? [];
      handlers.forEach((handler, index) => {
        state.set(`${SESSION_FLAGS_SOURCE}:${label}:${delivered.length}:${index}`, {
          trusted_hash: codexTrustedHash(event, group.matcher, handler),
          enabled: true,
        });
      });
      const matcher = group.matcher === undefined ? {} : { matcher: group.matcher };
      events.set(event, [...delivered, { ...matcher, hooks: handlers }]);
    }
  }
  if (events.size === 0) return undefined;
  const table = Object.fromEntries(events);
  return state.size > 0 ? { ...table, state: Object.fromEntries(state) } : table;
}
