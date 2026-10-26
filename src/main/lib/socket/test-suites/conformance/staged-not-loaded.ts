import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { expect, onTestFinished, vi } from 'vitest';
import { getGlobalMcpServers } from '../../../mcp/config';
import { STAGED_VS_LOADED_SURFACE } from '../../../provider/staged-vs-loaded';
import { captureMainMessage } from '../../../sentry/init';
import { type Observed, startRow } from './drive';
import { CLAUDE_REPLY, type ScenarioFixtures, SIMPLE_TURN } from './fixtures';
import type { Scenario } from './grid';

const NO_SERVERS: { name: string; status: string }[] = [];
// SAFETY: the transformer and the session reader read only these fields of an init frame.
const CLAUDE_INIT_WITHOUT_SERVERS = [
  { type: 'system', subtype: 'init', mcp_servers: NO_SERVERS },
] as SDKMessage[];

/** Claude's init lists no MCP server; the other runtimes play a plain reply. */
const STAGED_NOT_LOADED: ScenarioFixtures = {
  ...SIMPLE_TURN,
  claude: { source: 'SCRIPTED', turn: [...CLAUDE_INIT_WITHOUT_SERVERS, ...CLAUDE_REPLY] },
};

/** Named for its row, so one row's report is never deduplicated against another's. */
const stagedServer = (subChatId: string) => `conformance-${subChatId.slice(0, 8)}`;

/** Every launch in this test resolves one more Frink MCP server; the suite's own comes back after. */
function stageConformanceMcp(name: string): void {
  const servers = vi.mocked(getGlobalMcpServers);
  const suite = servers.getMockImplementation();
  const url = 'http://127.0.0.1:9/mcp';
  servers.mockResolvedValue({
    [name]: { name, type: 'cloud_api', authType: 'none', command: '', url },
  });
  onTestFinished(() => {
    servers.mockReset();
    if (suite) servers.mockImplementation(suite);
  });
}

/** The same MCP server reaches every runtime's launch, as each resolves Frink's servers. */
export const playStagedNotLoaded: Scenario['play'] = async (h, runtime) => {
  const row = startRow(h, runtime);
  stageConformanceMcp(stagedServer(row.subChatId));
  await row.turn(STAGED_NOT_LOADED[runtime].turn);
  return row.observe();
};

/** The staged-vs-loaded reports sent for one sub-chat. */
const loadReports = (subChatId: string) =>
  vi
    .mocked(captureMainMessage)
    .mock.calls.flatMap(([message, , tags]) =>
      tags?.surface === STAGED_VS_LOADED_SURFACE && tags.subChatId === subChatId ? [message] : [],
    );

export async function expectStagedNotLoadedReported({ subChatId }: Observed): Promise<void> {
  const report = expect.stringContaining(stagedServer(subChatId));
  await vi.waitFor(() => expect(loadReports(subChatId)).toEqual([report]));
}
