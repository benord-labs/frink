import type { Query, Settings } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/** The policy setting that makes Claude run plugin hooks only, reading no settings file's hooks. */
export const PLUGIN_ONLY_HOOKS = { strictPluginOnlyCustomization: ['hooks'] } satisfies Settings;

/** Whether an admin policy on this machine (or `serverManagedSettings`, when given) leaves a launch
 * under {@link PLUGIN_ONLY_HOOKS}, by the SDK's resolver: a policy drops it unless it opts in. */
export async function pluginOnlyHooksHold(serverManagedSettings?: Settings): Promise<boolean> {
  const { resolveSettings } = await import('@anthropic-ai/claude-agent-sdk');
  const { effective } = await resolveSettings({
    settingSources: [],
    managedSettings: PLUGIN_ONLY_HOOKS,
    ...(serverManagedSettings && { serverManagedSettings }),
  });
  const lock = effective.strictPluginOnlyCustomization;
  return lock === true || (Array.isArray(lock) && lock.includes('hooks'));
}

const HooksListing = z.object({ policy: z.object({ pluginOnly: z.boolean() }) });
type HooksListing = z.infer<typeof HooksListing>;

declare module '@anthropic-ai/claude-agent-sdk' {
  interface Query {
    /** The CLI's `/hooks` listing: the SDK's Query answers it, though its declarations omit it. */
    getHooksListing(): Promise<HooksListing>;
  }
}

/** Whether a started Claude CLI runs under {@link PLUGIN_ONLY_HOOKS}, by its own hooks listing,
 * which sees every policy tier, the org's server-managed one too; null when it cannot say. */
export async function cliRunsPluginOnlyHooks(
  query: Pick<Query, 'initializationResult' | 'getHooksListing'>,
): Promise<boolean | null> {
  try {
    await query.initializationResult();
    return HooksListing.parse(await query.getHooksListing()).policy.pluginOnly;
  } catch {
    return null;
  }
}
