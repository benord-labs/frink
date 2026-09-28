import { PATH_TOOLS, SEARCH_TOOLS } from '../../../../../shared/types/permissions';

/** Host-resolved Glob/Grep search root on the decision input. A Symbol key: JSON tool input
 * cannot forge it, and serialization drops it. */
export const SEARCH_ROOT: unique symbol = Symbol('frink.permissions.searchRoot');

export function buildPermissionDecisionInput(
  toolName: string,
  toolInput: Record<string, unknown>,
  permissionPathOverride?: string,
): Record<string, unknown> {
  if (!permissionPathOverride) return toolInput;
  // Search tools keep the agent's own args; the canonical root rides alongside.
  if (SEARCH_TOOLS.has(toolName)) return { ...toolInput, [SEARCH_ROOT]: permissionPathOverride };
  if (!PATH_TOOLS.has(toolName)) return toolInput;
  return { ...toolInput, file_path: permissionPathOverride, file: undefined, path: undefined };
}

/** The host-resolved search root, if `buildPermissionDecisionInput` attached one. */
export function readSearchRoot(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = (input as { [SEARCH_ROOT]?: unknown })[SEARCH_ROOT];
  return typeof value === 'string' ? value : undefined;
}
