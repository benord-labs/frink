import { LAUNCH_FLAGS } from '../../launch-flags';
import type { ChatMode } from '../../types/chat-mode';
import { type CapabilityRow, NOTHING_DELIVERED } from './capabilities';

/** What drives a provider: Claude's SDK, Codex's app server, ACP, or Copilot's or Cursor's SDK. */
export const AGENT_RUNTIMES = ['claude', 'codex', 'acp', 'copilot', 'cursor'] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

type LaunchFlagName = keyof typeof LAUNCH_FLAGS;
type LaunchFlags = Partial<Record<LaunchFlagName, boolean>>;

type BaseRow = {
  name: string;
  longName: string;
  passthroughSource: string;
  capabilities: CapabilityRow;
  // Tagged Preview where people pick it: chats work, but some of Frink's features don't yet.
  preview?: boolean;
};
type AiProviderRow =
  // On Claude and Codex the flag only hides the provider from pickers.
  | (BaseRow & { runtime: 'claude'; flag?: LaunchFlagName })
  | (BaseRow & { runtime: 'codex'; flag?: LaunchFlagName })
  | (BaseRow & {
      runtime: 'acp' | 'copilot' | 'cursor';
      flag: LaunchFlagName;
      // The agent's own modes for Frink's Agent and Plan; both are sent every turn.
      agentMode?: string;
      planMode?: string;
      installHint: string;
      signInHint: string;
      // Operating systems this agent has been checked on.
      platforms: readonly string[];
    });

/** Every AI provider Frink knows. An account type outside this table never runs. */
export const AI_PROVIDERS = {
  'claude-code': {
    runtime: 'claude',
    name: 'Claude',
    longName: 'Claude Code',
    passthroughSource: 'claude-passthrough',
    capabilities: {
      delivery: {
        mcp: 'inject',
        skills: 'copy',
        commands: 'copy',
        agentBrain: 'inject',
        allowlist: 'enforce',
        hooks: 'file',
        // Vendor plugins reach a chat as a hook-stripped copy in its own config folder.
        plugins: 'copy',
        // The user's CLAUDE.md is copied into each chat's own config folder.
        instructions: 'copy',
      },
    },
  },
  codex: {
    runtime: 'codex',
    name: 'OpenAI',
    longName: 'Codex',
    passthroughSource: 'codex-passthrough',
    flag: 'codexAccounts',
    capabilities: {
      delivery: {
        mcp: 'inject',
        skills: 'copy',
        // The app server takes no commands; Frink expands a slash command before sending it.
        commands: 'none',
        // Sub-agent roles load only as `.toml` files under `~/.codex/agents`.
        agentBrain: 'copy',
        allowlist: 'enforce',
        // Each thread is started with the user's stored hooks.
        hooks: 'inject',
        // Staged plugins' skills are added for each launch through the app server.
        plugins: 'inject',
        instructions: 'none',
      },
    },
  },
  opencode: {
    runtime: 'acp',
    name: 'OpenCode',
    longName: 'OpenCode',
    passthroughSource: 'opencode-passthrough',
    preview: true,
    flag: 'opencodeAccounts',
    agentMode: 'build',
    planMode: 'plan',
    installHint: 'npm install -g opencode-ai@1.19',
    signInHint: 'opencode auth login',
    platforms: ['darwin', 'linux'],
    // The launch hands OpenCode the user's instructions files and skill folders in memory.
    capabilities: { delivery: { ...NOTHING_DELIVERED, skills: 'inject', instructions: 'inject' } },
  },
  copilot: {
    runtime: 'copilot',
    name: 'GitHub Copilot',
    longName: 'GitHub Copilot CLI',
    passthroughSource: 'copilot-passthrough',
    preview: true,
    flag: 'copilotAccounts',
    planMode: 'plan',
    installHint: 'npm install -g @github/copilot',
    signInHint: 'copilot login',
    platforms: ['darwin', 'linux'],
    capabilities: { delivery: NOTHING_DELIVERED },
  },
  cursor: {
    runtime: 'cursor',
    name: 'Cursor',
    longName: 'Cursor',
    passthroughSource: 'cursor-passthrough',
    preview: true,
    flag: 'cursorAccounts',
    planMode: 'plan',
    installHint: 'Sign in to Cursor from Frink. Cursor needs a paid plan.',
    signInHint: 'Sign in to Cursor',
    platforms: ['darwin', 'linux'],
    // Frink hands Cursor only the turn, which runs on its own settings in a Frink-owned home.
    capabilities: { delivery: NOTHING_DELIVERED },
  },
  grok: {
    runtime: 'acp',
    name: 'Grok',
    longName: 'Grok Build',
    passthroughSource: 'grok-passthrough',
    flag: 'grokAccounts',
    installHint: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    signInHint: 'grok login',
    platforms: ['darwin'],
    capabilities: { delivery: NOTHING_DELIVERED },
  },
} as const satisfies Record<string, AiProviderRow>;

export type AiProviderId = keyof typeof AI_PROVIDERS;
export type PassthroughSource = (typeof AI_PROVIDERS)[AiProviderId]['passthroughSource'];

export const AI_PROVIDER_IDS =
  // SAFETY: Object.keys of a literal object with no other keys.
  Object.keys(AI_PROVIDERS) as AiProviderId[];
export const PASSTHROUGH_SOURCES = AI_PROVIDER_IDS.map((id) => AI_PROVIDERS[id].passthroughSource);

function isAiProviderId(type: string): type is AiProviderId {
  return Object.hasOwn(AI_PROVIDERS, type);
}

/** The row for an account type. A missing type is a legacy Claude row; an unknown one has none. */
export function aiProvider(
  type: string | null | undefined,
): (AiProviderRow & { id: AiProviderId }) | undefined {
  const id = type ?? 'claude-code';
  return isAiProviderId(id) ? { ...AI_PROVIDERS[id], id } : undefined;
}

/** An agent run from the user's own install: it keeps its own sign-in and lists its own models. */
export function isInstalledAgent<R extends { runtime: AgentRuntime }>(
  row: R | undefined,
): row is Exclude<R, { runtime: 'claude' | 'codex' }> {
  return row !== undefined && row.runtime !== 'claude' && row.runtime !== 'codex';
}

/** Frink modes a provider has no equivalent for yet: never offered, and refused if sent. */
export function unsupportedModes(type: string | null | undefined): ChatMode[] {
  const row = aiProvider(type);
  // Codex is sent no plan mode, so a Plan turn would edit files instead of planning.
  if (row?.runtime === 'codex') return ['plan'];
  if (!isInstalledAgent(row)) return [];
  return row.planMode ? ['debug'] : ['plan', 'debug'];
}

/** Why a turn can't run in this mode on this provider, or null when it can. */
export function unsupportedModeMessage(
  type: string | null | undefined,
  mode: ChatMode,
): string | null {
  const row = aiProvider(type);
  if (!row || !unsupportedModes(type).includes(mode)) return null;
  return `${mode === 'plan' ? 'Plan' : 'Debug'} mode isn't available for ${row.name} yet.`;
}

export function agentRunnable(
  row: { flag: LaunchFlagName; platforms: readonly string[] },
  flags: LaunchFlags,
  platform?: string,
): boolean {
  return flags[row.flag] === true && platform !== undefined && row.platforms.includes(platform);
}

/** The runtime that may run this account type here, or undefined when it may not run at all. */
export function runtimeFor(
  type: string | null | undefined,
  flags: LaunchFlags = LAUNCH_FLAGS,
  platform?: string,
): AgentRuntime | undefined {
  const row = aiProvider(type);
  if (!isInstalledAgent(row)) return row?.runtime;
  return agentRunnable(row, flags, platform) ? row.runtime : undefined;
}

/** Providers a person may pick or connect, in table order. */
export function selectableProviderIds(
  flags: LaunchFlags = LAUNCH_FLAGS,
  platform?: string,
): AiProviderId[] {
  return AI_PROVIDER_IDS.filter((id) => {
    const row = AI_PROVIDERS[id];
    if (isInstalledAgent(row)) return agentRunnable(row, flags, platform);
    return !('flag' in row) || flags[row.flag] === true;
  });
}
