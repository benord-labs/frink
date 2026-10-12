/** The vendor id behind "only when it's assigned to me": the plugin manifest's identity lookup asks its
 * MCP server who is signed in and stamps that id on this machine's rows; unresolved costs only "me". */
import log from 'electron-log';
import { z } from 'zod';
import { catalogIdentity } from '../../../../shared/integrations/catalog';
import type { getDatabase } from '../../db';
import {
  listLocalIntegrations,
  setLocalIntegrationExternalUserId,
} from '../../db/repos/webhook-ingress';
import { callServerTool } from '../../mcp/tools-probe/resolve';
import { resolvePluginServerTarget } from '../plugin-node-derivation/server-target';

type Db = ReturnType<typeof getDatabase>;

// A server that spells an absent field as null is as valid as one that omits it.
const TOOL_RESULT = z.object({
  content: z.array(z.object({ text: z.string().nullish() })).nullish(),
  structuredContent: z.record(z.string(), z.json()).nullish(),
});

const JSON_VALUE = z.json();
const JSON_OBJECT = z.record(z.string(), z.json());

/** Whatever an MCP server sent back, already narrowed to JSON. */
type IdentityPayload = z.infer<typeof JSON_VALUE>;

/** Structured output when the server sends it, else the JSON its text blocks carry. */
function payloadOf(result: IdentityPayload): IdentityPayload {
  const parsed = TOOL_RESULT.safeParse(result);
  if (!parsed.success) return null;
  if (parsed.data.structuredContent) return parsed.data.structuredContent;
  const text = (parsed.data.content ?? []).map((block) => block.text ?? '').join('');
  // Servers often prefix JSON with a sentence (Shortcut: "Current user:\n\n<json>…</json>").
  const json = text.match(/<json>\s*([\s\S]*?)\s*<\/json>/)?.[1] ?? text.slice(text.indexOf('{'));
  try {
    return JSON_VALUE.catch(null).parse(JSON.parse(json));
  } catch {
    return null;
  }
}

/** The id at the declared dot path; a numeric segment indexes a list. Numeric ids (GitHub-style)
 * become strings; anything else is no id. */
export function readIdentityId(result: IdentityPayload, idPath: string): string | undefined {
  const value = idPath.split('.').reduce<IdentityPayload>((node, key) => {
    if (Array.isArray(node)) return /^\d+$/.test(key) ? (node[Number(key)] ?? null) : null;
    const object = JSON_OBJECT.safeParse(node);
    return object.success ? (object.data[key] ?? null) : null;
  }, payloadOf(result));
  const text = z.string().safeParse(value);
  if (text.success) return text.data.trim() === '' ? undefined : text.data;
  const number = z.number().safeParse(value);
  return number.success ? String(number.data) : undefined;
}

/** One plain warning, no token and no result body. */
function unavailable(pluginId: string, reason: string): undefined {
  log.warn(`[PluginIdentity] ${pluginId}: ${reason}`);
  return undefined;
}

/** How a lookup reaches the plugin's server. */
const SERVER = { resolvePluginServerTarget, callServerTool };

export async function lookUpIdentity(
  pluginId: string,
  server = SERVER,
): Promise<string | undefined> {
  const declared = catalogIdentity(pluginId);
  if (!declared) return undefined;
  const resolved = await server.resolvePluginServerTarget(pluginId, declared.server);
  if (!resolved.ok) return unavailable(pluginId, resolved.reason);
  const called = await server.callServerTool(
    resolved.target.config,
    resolved.target.credentials,
    declared.tool,
    declared.args ?? {},
  );
  if (!called.ok) return unavailable(pluginId, called.reason);
  return (
    readIdentityId(JSON_VALUE.catch(null).parse(called.result), declared.idPath) ??
    unavailable(pluginId, `${declared.tool} returned no id`)
  );
}

/** A plugin holds ONE chat grant on this machine, so its trigger accounts share one identity: the rows
 * cache the grant's answer. Identity is a convenience, never a reason for a connect or Turn on to fail. */
export async function ensureLocalAccountIdentity(
  db: Db,
  pluginId: string,
  accountId?: string,
  lookUp: (pluginId: string) => Promise<string | undefined> = lookUpIdentity,
): Promise<void> {
  if (!catalogIdentity(pluginId)) return;
  try {
    // One chat grant per plugin, so one identity; a caller that just made one row stamps only that row.
    const pending = (await listLocalIntegrations(db)).filter(
      (row) =>
        row.provider === pluginId && !row.externalUserId && (!accountId || row.id === accountId),
    );
    if (pending.length === 0) return;
    const externalUserId = await lookUp(pluginId);
    if (!externalUserId) return;
    for (const account of pending)
      await setLocalIntegrationExternalUserId(db, account.id, externalUserId);
  } catch (error) {
    unavailable(pluginId, String(error));
  }
}
