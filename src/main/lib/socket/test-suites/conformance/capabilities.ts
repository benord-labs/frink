import { expect, it, onTestFinished, vi } from 'vitest';
import { AI_PROVIDER_IDS, AI_PROVIDERS } from '../../../../../shared/lib/ai-providers';
import type { CapabilityRow } from '../../../../../shared/lib/ai-providers/capabilities';
import * as frinkServers from '../../../mcp/runtime/resolve-frink-servers';
import * as hookLaunch from '../../../provider/hooks/store/launch';
import * as providerDelivery from '../../execution/provider-delivery';
import { type GridHarness, startRow } from './drive';
import { SIMPLE_TURN } from './fixtures';

/** Which of the executor's launch seams one turn reached. */
type Handed = { mcp: boolean; hooks: boolean; files: boolean };

/** What a row claims at the executor's seams; deliverProviderConfig is the spawn-time file copy. */
function claimed({ delivery }: CapabilityRow): Handed {
  return {
    mcp: delivery.mcp !== 'none',
    hooks: delivery.hooks !== 'none',
    files: [delivery.skills, delivery.commands, delivery.agentBrain].includes('copy'),
  };
}

/** Spies, calling through, on the seams that hand a launch its MCP servers, hooks and files. */
function spyOnLaunchSeams(): () => Handed {
  const seams = {
    mcp: vi.spyOn(frinkServers, 'resolveFrinkMcpServers'),
    hooks: vi.spyOn(hookLaunch, 'hooksForLaunch'),
    files: vi.spyOn(providerDelivery, 'deliverProviderConfig'),
  };
  onTestFinished(() => Object.values(seams).forEach((spy) => spy.mockRestore()));
  return () => ({
    mcp: seams.mcp.mock.calls.length > 0,
    hooks: seams.hooks.mock.calls.length > 0,
    files: seams.files.mock.calls.length > 0,
  });
}

/** One row per provider: its launch is handed exactly the categories its capability row claims.
 * Registered inside the grid's describe, so each Claude row starts a fresh session. */
export function registerCapabilityRows(h: GridHarness): void {
  it.each(AI_PROVIDER_IDS)('conformance: delivery x %s', async (id) => {
    const { runtime, capabilities } = AI_PROVIDERS[id];
    const handed = spyOnLaunchSeams();
    // Claude keeps the suite's own account; every other provider runs on its own.
    const row = startRow(h, runtime, id === 'claude-code' ? undefined : id);
    await row.turn(SIMPLE_TURN[runtime].turn);
    expect(handed()).toEqual(claimed(capabilities));
  });
}
