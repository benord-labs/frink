import type { AgentRuntime } from '../../../../shared/lib/ai-providers';
import { FRINK_MCP_KEY } from '../../../../shared/lib/mcp-tool-name';
import { getRuntimeBaseTools } from '../dynamic-chat-tool-catalog';
import { getChannelToken, withChannelQuery } from '../execution-identity';
import { FLOWS_TOOLS } from '../flows-tools/definitions';

/** Frink's own MCP server as one turn reaches it: its server key, and its URL on the turn's channel. */
export type FrinkToolsServer = { name: string; url: string };

type FrinkToolsServerInput = {
  /** The server's base URL from the chat's workspace; null when it did not start. */
  baseUrl: string | null;
  subChatId: string;
  runtime: AgentRuntime;
  hasSignalTask: boolean;
  /** A channel the caller minted itself; by default the sub-chat's current one for `runtime`. */
  channel?: string;
};

/** The one URL builder for Frink's server, shared by every runtime. Undefined when it did not start. */
export function frinkToolsServer(input: FrinkToolsServerInput): FrinkToolsServer | undefined {
  const { baseUrl, subChatId, runtime, hasSignalTask, channel } = input;
  if (!baseUrl) return undefined;
  const token = channel ?? getChannelToken(subChatId, runtime);
  return { name: FRINK_MCP_KEY, url: withChannelQuery(baseUrl, token, hasSignalTask) };
}

/** Every tool Frink's server can list; its kill switches only shorten the listing itself. */
export function frinkToolNames(): string[] {
  return [...getRuntimeBaseTools(), ...FLOWS_TOOLS].map(({ name }) => name);
}

/** A Frink tool's text result as an MCP result, the shape Claude and Codex cards already read. */
export function frinkToolOutput(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
