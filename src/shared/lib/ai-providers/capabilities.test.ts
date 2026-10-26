import { describe, expect, it } from 'vitest';
import { builtinRuntimeSupport } from '../../integrations/plugin-runtime-support';
import { AI_PROVIDER_IDS, AI_PROVIDERS, type AiProviderId } from '.';

const delivery = (id: AiProviderId) => AI_PROVIDERS[id].capabilities.delivery;

describe('capability rows', () => {
  it('lists a plugin runtime exactly when its row delivers plugins', () => {
    // A row's `plugins` leaving `none` (Cursor, one day) must add that provider to the Plugins page.
    const delivering = AI_PROVIDER_IDS.filter((id) => delivery(id).plugins !== 'none').sort();
    const listed = Object.keys(
      builtinRuntimeSupport({
        mcpServers: [],
        skills: [],
        nativeExtensions: [],
        triggers: [],
        actions: [],
      }),
    ).sort();
    expect(listed).toEqual(delivering);
  });

  it('limits sub-agent tools only for a provider it hands sub-agents to', () => {
    const limitsWithoutAgents = AI_PROVIDER_IDS.filter(
      (id) => delivery(id).allowlist !== 'none' && delivery(id).agentBrain === 'none',
    );
    expect(limitsWithoutAgents).toEqual([]);
  });
});
