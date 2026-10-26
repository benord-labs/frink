import { expect, it, onTestFinished, vi } from 'vitest';
import {
  AI_PROVIDER_IDS,
  AI_PROVIDERS,
  type AgentRuntime,
} from '../../../../../shared/lib/ai-providers';
import {
  type CapabilityRow,
  FEATURES,
  type Feature,
} from '../../../../../shared/lib/ai-providers/capabilities';
import * as frinkServers from '../../../mcp/runtime/resolve-frink-servers';
import * as hookLaunch from '../../../provider/hooks/store/launch';
import * as providerDelivery from '../../execution/provider-delivery';
import { EXPECTED_FAILURES, FEATURE_ROWS } from './baseline';
import { drivenAs, type GridHarness, startRow } from './drive';
import { SIMPLE_TURN } from './fixtures';
import type { Scenario } from './grid';

/** Which of the executor's launch seams one turn reached. */
type Handed = { mcp: boolean; hooks: boolean; files: boolean };

/** What a row claims at the executor's seams; deliverProviderConfig is the spawn-time file copy. */
function claimed({ delivery }: CapabilityRow): Handed {
  return {
    mcp: delivery.mcp !== 'none',
    hooks: delivery.hooks !== 'none',
    files: [delivery.skills, delivery.commands, delivery.agentBrain].some(
      (mode) => mode === 'copy' || mode === 'file',
    ),
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

/** A flag's rows pass on a runtime only if each scenario runs there and is not listed. */
function rowsPass(
  scenarios: readonly Scenario[],
  feature: Feature,
  runtime: AgentRuntime,
): boolean {
  return FEATURE_ROWS[feature].every((id) => {
    const scenario = scenarios.find((s) => s.id === id);
    const covers =
      scenario !== undefined && (scenario.appliesTo?.runtimes.includes(runtime) ?? true);
    return covers && !(`${id} x ${runtime}` in EXPECTED_FAILURES);
  });
}

/** One row per provider: its launch is handed exactly the categories its capability row claims,
 * and it holds exactly the feature flags its runtime's grid rows pass. */
export function registerCapabilityRows(h: GridHarness, scenarios: readonly Scenario[]): void {
  it.each(AI_PROVIDER_IDS)('conformance: delivery x %s', async (id) => {
    const { runtime, capabilities } = AI_PROVIDERS[id];
    const handed = spyOnLaunchSeams();
    // Claude keeps the suite's own account; every other provider runs on its own.
    const row = startRow(h, runtime, id === 'claude-code' ? undefined : id);
    await row.turn(SIMPLE_TURN[runtime].turn);
    expect(handed()).toEqual(claimed(capabilities));
  });

  it.each(AI_PROVIDER_IDS)('conformance: features x %s', (id) => {
    const { runtime, capabilities } = AI_PROVIDERS[id];
    const held = FEATURES.filter((feature) => capabilities.features[feature]);
    const verified = FEATURES.filter((feature) => rowsPass(scenarios, feature, runtime));
    // A provider the grid never drives (Grok on ACP) may leave a verified flag off, never add one.
    const allowed = drivenAs(runtime) === id ? verified : held.filter((f) => verified.includes(f));
    expect(held).toEqual(allowed);
  });
}
