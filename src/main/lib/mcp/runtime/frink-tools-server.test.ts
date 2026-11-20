import { describe, expect, it } from 'vitest';
import { AGENT_RUNTIMES } from '../../../../shared/lib/ai-providers';
import { FRINK_MCP_KEY } from '../../../../shared/lib/mcp-tool-name';
import { channelOwner, parseExecutionIdentity } from '../execution-identity';
import { frinkToolsServer } from './frink-tools-server';

const BASE = 'http://127.0.0.1:4312';

describe('frinkToolsServer', () => {
  it('gives every runtime its own channel on the shared server, resolving back to that runtime', () => {
    const channels = AGENT_RUNTIMES.map((runtime) => {
      const server = frinkToolsServer({
        baseUrl: BASE,
        subChatId: 'sub-all',
        runtime,
        hasSignalTask: false,
      });
      expect(server?.name).toBe(FRINK_MCP_KEY);
      const { channel, toolset } = parseExecutionIdentity(server?.url);
      expect(toolset).toBe('nosignal');
      expect(channelOwner(channel)).toEqual({ subChatId: 'sub-all', runtime });
      return channel;
    });
    expect(new Set(channels).size).toBe(AGENT_RUNTIMES.length);
  });

  it("uses a caller's own channel as given, and offers no server when it did not start", () => {
    const at = (baseUrl: string | null) =>
      frinkToolsServer({
        baseUrl,
        subChatId: 'sub-claude',
        runtime: 'claude',
        hasSignalTask: true,
        channel: 'tok-minted',
      });
    expect(parseExecutionIdentity(at(BASE)?.url)).toEqual({
      channel: 'tok-minted',
      toolset: 'signal',
    });
    expect(at(null)).toBeUndefined();
  });
});
