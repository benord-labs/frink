/**
 * The generic call-tool node's picker data: one plugin server's live tools/list, projected to the
 * same manifest-input shape curated rows use so the renderer never sees a raw JSON schema.
 */
import { getPluginDefinition } from '../../../../shared/integrations';
import { isGenericCallToolAction } from '../../../../shared/integrations/plugin-nodes';
import {
  jsonSchemaToManifestInputs,
  type ManifestInputProjection,
} from '../../../../shared/lib/flows/json-schema-to-manifest-inputs';
import type { McpToolDescriptor } from '../../mcp/tools-probe';
import { captureMainMessage } from '../../sentry/init';
import { fetchServerDescriptors } from './schema-cache';

type PluginServerToolRow = {
  name: string;
  title?: string;
  description?: string;
  readOnly: boolean;
  destructive: boolean;
  inputs: Record<string, ManifestInputProjection>;
  unsupportedFields: string[];
};

export type PluginServerToolsResult =
  | { ok: true; tools: PluginServerToolRow[] }
  | { ok: false; reason: string };

/** Annotations are hints for the picker's chrome only — never an enforcement input (frink-mcp-tool-permission-trust). */
function toRow(descriptor: McpToolDescriptor): PluginServerToolRow {
  const { name, title, description, annotations } = descriptor;
  const row: PluginServerToolRow = {
    name,
    readOnly: annotations?.readOnlyHint === true,
    destructive: annotations?.destructiveHint === true,
    ...jsonSchemaToManifestInputs(descriptor.inputSchema ?? {}),
  };
  if (title !== undefined) row.title = title;
  if (description !== undefined) row.description = description;
  return row;
}

/** Whole-list budget on top of the transport's own: a stuck credential refresh must not hang the picker. */
const LIST_TIMEOUT_MS = 15_000;

export async function listPluginServerTools(pluginId: string): Promise<PluginServerToolsResult> {
  const action = getPluginDefinition(pluginId)?.contents.actions.find(isGenericCallToolAction);
  if (!action) return { ok: false, reason: `${pluginId} has no call-tool node.` };
  const timeout = new Promise<{ ok: false; reason: string }>((resolve) =>
    setTimeout(
      () =>
        resolve({
          ok: false,
          reason: `Reading ${pluginId}'s tool list took too long — check its connection in Settings → Plugins.`,
        }),
      LIST_TIMEOUT_MS,
    ).unref(),
  );
  try {
    const fetched = await Promise.race([
      fetchServerDescriptors(pluginId, action.source.serverId),
      timeout,
    ]);
    if (!fetched.ok) return fetched;
    return { ok: true, tools: [...fetched.byTool.values()].map(toRow) };
  } catch (error) {
    // A thrown credential or registry read is a failure to show, in the user's words, never a tRPC error.
    captureMainMessage(
      `Plugin tool list failed: ${error instanceof Error ? error.message : String(error)}`,
      'warning',
      {
        surface: 'plugin-node-picker',
        pluginId,
      },
    );
    return {
      ok: false,
      reason: `Frink couldn't read ${pluginId}'s saved sign-in. Reconnect it in Settings → Plugins.`,
    };
  }
}
