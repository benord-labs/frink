/**
 * Presentation helpers for the plugin detail page: the single chain the band
 * draws, its summary line, and which tier each capability row renders in.
 */
import type { ResolvedPlugin } from '../../../shared/integrations/plugins';
import type { PluginCapabilityRow } from './plugin-view-model';
import { promptsFor } from './plugin-prompts';

/** A browser grant can also authorize Frink's automatic trigger setup. */
export function mcpSuppliesTriggerCredential(plugin: ResolvedPlugin): boolean {
  return plugin.definition.provider?.registrar?.credential === 'mcp';
}

/** Tools can require their own sign-in even when the plugin has no Flow account. */
export function mcpAuthItems(plugin: ResolvedPlugin): PluginCapabilityRow['items'] {
  const labels = {
    frink_client: 'Browser sign-in',
    static_client: 'Browser sign-in',
    user_token: 'API token',
    pending: 'Not available yet',
  };
  return plugin.definition.contents.mcpServers.flatMap(({ id, transport }) =>
    transport.type === 'http'
      ? [
          {
            id,
            label: labels[transport.auth.kind],
            note: mcpSuppliesTriggerCredential(plugin) ? 'For tools and triggers' : 'For tools',
          },
        ]
      : [],
  );
}

export type ChainStepData = {
  pluginId?: string;
  /** Present only on a real trigger's start step — the id "Use in Flow" hands back. */
  triggerId?: string;
  label: string;
  detail: string;
  caption: string;
};

/** Only webhook triggers supply the leading event slide. */
export function bandChain(plugin: ResolvedPlugin): [ChainStepData, ChainStepData] | null {
  const { id, name, contents } = plugin.definition;
  const trigger = contents.triggers[0];
  if (!trigger) return null;
  return [
    {
      pluginId: id,
      triggerId: trigger.id,
      label: name,
      detail: trigger.label,
      caption: 'When this happens',
    },
    { label: 'Frink', detail: 'runs your Flow', caption: 'Frink does this' },
  ];
}

/** Flow actions lead the prompts; general examples follow when the package supports them. */
export function bandPrompts(plugin: ResolvedPlugin): readonly string[] {
  const { id, contents } = plugin.definition;
  const flowAsk = flowStepPrompt(plugin);
  const general = contents.mcpServers.length || contents.skills.length ? promptsFor(id) : [];
  const examples = general.length
    ? general
    : contents.skills.map((skill) => `Use the ${skill.name} skill to help me with this project`);
  return flowAsk ? [flowAsk, ...examples] : examples;
}

export function flowStepPrompt(plugin: ResolvedPlugin): string | null {
  const { contents } = plugin.definition;
  const action =
    contents.actions.find((entry) => 'mutates' in entry && entry.mutates) ?? contents.actions[0];
  if (!action) return null;
  return `Build me a Flow with a “${action.label}” step in the middle`;
}

/** The band's summary line: the trigger sample plus the tools half, so it never reads triggers-only. */
export function bandSummary(
  triggerCount: number,
  agentToolCount: number,
  chatToolsAvailable: boolean,
): string {
  const parts: string[] = [];
  if (triggerCount > 1) parts.push(`1 of ${triggerCount} triggers`);
  if (agentToolCount === 1) parts.push('1 tool below');
  if (agentToolCount > 1) parts.push(`${agentToolCount} tools below`);
  if (chatToolsAvailable && agentToolCount > 0) parts.push('tools work in chats too');
  return parts.join(' · ');
}

export type CapabilityTierId = 'accounts' | 'inventory' | 'fact' | 'matrix';

/**
 * Tier per row id; key order is the page order. An unknown id falls to the
 * inventory tier so a new capability still reaches the page.
 */
const ROW_TIER: Record<string, CapabilityTierId> = {
  accounts: 'accounts',
  'agent-tools': 'inventory',
  triggers: 'inventory',
  skills: 'inventory',
  source: 'fact',
  version: 'fact',
  auth: 'fact',
  'works-in': 'matrix',
};

const TIER_ORDER = Object.keys(ROW_TIER);

function tierRank(id: string): number {
  const rank = TIER_ORDER.indexOf(id);
  return rank < 0 ? TIER_ORDER.length : rank;
}

/** One tier's rows in the page's order, which is deliberately not the model's. */
export function capabilityRowsInTier(
  rows: PluginCapabilityRow[],
  tier: CapabilityTierId,
): PluginCapabilityRow[] {
  return rows
    .filter((row) => (ROW_TIER[row.id] ?? 'inventory') === tier)
    .sort((first, second) => tierRank(first.id) - tierRank(second.id));
}
