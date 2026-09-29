/** Routes a manifest read from ~/.frink/nodes before the script entrypoint parse: a leftover plugin-kind
 * manifest is skipped (plugin nodes are derived, never on disk); a namespace squatter is an error. */
import { reservedPluginIdForNodeName } from '../../../../shared/integrations/plugin-nodes';

export type PluginNodeManifestBranch =
  | { branch: 'script' }
  | { branch: 'plugin' }
  | { branch: 'error'; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Non-objects fall through to the script path so its existing error messages stay intact. */
export function classifyNodeManifest(raw: unknown, dirName: string): PluginNodeManifestBranch {
  if (!isRecord(raw)) return { branch: 'script' };
  const obj = raw;
  if (obj.kind === 'plugin_mcp_tool' || obj.kind === 'plugin_operation')
    return { branch: 'plugin' };
  if (obj.kind !== undefined && obj.kind !== 'script') {
    return {
      branch: 'error',
      error: `invalid "kind" ${JSON.stringify(obj.kind)} — expected "script" (default)`,
    };
  }
  if (Object.hasOwn(obj, 'owner')) {
    return {
      branch: 'error',
      error:
        '"owner" is only valid on generated plugin-node manifests, which Frink no longer reads from disk',
    };
  }
  const squattedId =
    reservedPluginIdForNodeName(dirName) ??
    (typeof obj.name === 'string' ? reservedPluginIdForNodeName(obj.name) : undefined);
  if (squattedId !== undefined) {
    return {
      branch: 'error',
      error: `node name is inside the "${squattedId}" plugin namespace ("${squattedId}_*"), which is reserved for that plugin's Flow steps — rename the node or remove the folder`,
    };
  }
  return { branch: 'script' };
}
