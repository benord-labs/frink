/** How a client addresses its run on the dynamic-chat MCP server: the channel token its process
 * carries plus the toolset it lists (decision codex-app-server-identity-scope). */


export type ChannelRuntime = 'claude' | 'codex';
export type ExecutionIdentity = { channel?: string; toolset?: string };

// Channel tokens are random rather than the sub-chat id, so no persisted domain id ends up in
// another process's argv. One current token per (runtime, sub-chat); older ones resolve nothing.
const channelTokens: Record<ChannelRuntime, Map<string, string>> = {
  claude: new Map(),
  codex: new Map(),
};
const channelOwners = new Map<string, { subChatId: string; runtime: ChannelRuntime }>();

/** The sub-chat's current channel token for one runtime, minted on first use. */
export function getChannelToken(subChatId: string, runtime: ChannelRuntime): string {
  const current = channelTokens[runtime].get(subChatId);
  return current ?? setChannelToken(subChatId, runtime, crypto.randomUUID());
}

/** Make `token` the sub-chat's current channel, retiring the one an earlier process carries. */
export function setChannelToken(subChatId: string, runtime: ChannelRuntime, token: string): string {
  invalidateChannelToken(subChatId, runtime);
  channelTokens[runtime].set(subChatId, token);
  channelOwners.set(token, { subChatId, runtime });
  return token;
}

export function channelOwner(channel?: string) {
  return channel ? channelOwners.get(channel) : undefined;
}

/** Drop a sub-chat's current token for one runtime: a request still carrying it resolves no run.
 * Codex calls it on dispose; Claude via setChannelToken (a new CLI) or retireChannelToken (abort). */
export function invalidateChannelToken(subChatId: string, runtime: ChannelRuntime): void {
  const token = channelTokens[runtime].get(subChatId);
  if (!token) return;
  channelTokens[runtime].delete(subChatId);
  channelOwners.delete(token);
}

/** Retire `channel` only while it is still current: a successor process's token is left alone. */
export function retireChannelToken(channel?: string): void {
  const owner = channelOwner(channel);
  if (owner) invalidateChannelToken(owner.subChatId, owner.runtime);
}

export function parseExecutionIdentity(url: string | undefined): ExecutionIdentity {
  if (!url) return {};
  const queryStart = url.indexOf('?');
  if (queryStart < 0) return {};
  const params = new URLSearchParams(url.slice(queryStart + 1));
  return {
    channel: params.get('channel') ?? undefined,
    toolset: params.get('toolset') ?? undefined,
  };
}

/**
 * The POST endpoint an SSE handshake hands back. Echoes the identity the CLIENT sent, verbatim —
 * resolving a channel to its current execution id here would re-bake a per-run id into a long-lived
 * client's URL, which is the staleness this whole mechanism exists to avoid.
 */
export function appendIdentityToEndpointUrl(baseUrl: string, identity: ExecutionIdentity): string {
  const endpointUrl = new URL(baseUrl);
  if (identity.channel) endpointUrl.searchParams.set('channel', identity.channel);
  if (identity.toolset) endpointUrl.searchParams.set('toolset', identity.toolset);
  return endpointUrl.toString();
}

/** A dynamic-chat URL on `channel`. The server lists tools from its `toolset`, so the URL (and a
 * reused process's spawn args) changes exactly when that list would. Mode is not part of it: plan
 * mode refuses flow tools per call, so a warm CLI can switch modes. */
export function withChannelQuery(baseUrl: string, channel: string, hasSignalTask: boolean): string {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set('channel', channel);
    url.searchParams.set('toolset', hasSignalTask ? 'signal' : 'nosignal');
    return url.toString();
  } catch {
    return baseUrl;
  }
}
