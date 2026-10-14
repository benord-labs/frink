import { LAUNCH_FLAGS } from '../../launch-flags';

/** What drives a provider: the Claude SDK, Codex's app server, or the Agent Client Protocol. */
export const AGENT_RUNTIMES = ['claude', 'codex', 'acp'] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

type LaunchFlagName = keyof typeof LAUNCH_FLAGS;
type LaunchFlags = Partial<Record<LaunchFlagName, boolean>>;

type BaseRow = { name: string; longName: string; passthroughSource: string };
type AiProviderRow =
  // On Claude and Codex the flag only hides the provider from pickers.
  | (BaseRow & { runtime: 'claude' | 'codex'; flag?: LaunchFlagName })
  | (BaseRow & {
      runtime: 'acp';
      flag: LaunchFlagName;
      // The agent's own modes for Frink's Agent and Plan; both are sent every turn.
      agentMode?: string;
      planMode?: string;
      installHint: string;
      signInHint: string;
    });

/** Every AI provider Frink knows. An account type outside this table never runs. */
export const AI_PROVIDERS = {
  'claude-code': {
    runtime: 'claude',
    name: 'Claude',
    longName: 'Claude Code',
    passthroughSource: 'claude-passthrough',
  },
  codex: {
    runtime: 'codex',
    name: 'OpenAI',
    longName: 'Codex',
    passthroughSource: 'codex-passthrough',
    flag: 'codexAccounts',
  },
  opencode: {
    runtime: 'acp',
    name: 'OpenCode',
    longName: 'OpenCode',
    passthroughSource: 'opencode-passthrough',
    flag: 'opencodeAccounts',
    agentMode: 'build',
    planMode: 'plan',
    installHint: 'npm install -g opencode-ai@1.19',
    signInHint: 'opencode auth login',
  },
  copilot: {
    runtime: 'acp',
    name: 'GitHub Copilot',
    longName: 'GitHub Copilot CLI',
    passthroughSource: 'copilot-passthrough',
    flag: 'copilotAccounts',
    installHint: 'npm install -g @github/copilot',
    signInHint: 'copilot login',
  },
  grok: {
    runtime: 'acp',
    name: 'Grok',
    longName: 'Grok Build',
    passthroughSource: 'grok-passthrough',
    flag: 'grokAccounts',
    installHint: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    signInHint: 'grok login',
  },
} as const satisfies Record<string, AiProviderRow>;

export type AiProviderId = keyof typeof AI_PROVIDERS;
export type PassthroughSource = (typeof AI_PROVIDERS)[AiProviderId]['passthroughSource'];

export const AI_PROVIDER_IDS =
  // SAFETY: Object.keys of a literal object with no other keys.
  Object.keys(AI_PROVIDERS) as AiProviderId[];
export const PASSTHROUGH_SOURCES = AI_PROVIDER_IDS.map((id) => AI_PROVIDERS[id].passthroughSource);

/** Operating systems where ACP agents have been checked. */
const ACP_PLATFORMS: readonly string[] = ['darwin'];

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

function acpRunnable(flag: LaunchFlagName, flags: LaunchFlags, platform?: string): boolean {
  return flags[flag] === true && platform !== undefined && ACP_PLATFORMS.includes(platform);
}

/** The runtime that may run this account type here, or undefined when it may not run at all. */
export function runtimeFor(
  type: string | null | undefined,
  flags: LaunchFlags = LAUNCH_FLAGS,
  platform?: string,
): AgentRuntime | undefined {
  const row = aiProvider(type);
  if (row?.runtime !== 'acp') return row?.runtime;
  return acpRunnable(row.flag, flags, platform) ? 'acp' : undefined;
}

/** Providers a person may pick or connect, in table order. */
export function selectableProviderIds(
  flags: LaunchFlags = LAUNCH_FLAGS,
  platform?: string,
): AiProviderId[] {
  return AI_PROVIDER_IDS.filter((id) => {
    const row = AI_PROVIDERS[id];
    if (row.runtime === 'acp') return acpRunnable(row.flag, flags, platform);
    return !('flag' in row) || flags[row.flag] === true;
  });
}
