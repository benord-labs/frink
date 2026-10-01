import { PATH_TOOLS, SEARCH_TOOLS } from '../../../../../shared/types/permissions';

export function buildPermissionDecisionInput(
  toolName: string,
  toolInput: Record<string, unknown>,
  permissionPathOverride?: string,
): Record<string, unknown> {
  if (!permissionPathOverride) return toolInput;
  if (SEARCH_TOOLS.has(toolName)) return { ...toolInput, path: permissionPathOverride };
  if (!PATH_TOOLS.has(toolName)) return toolInput;
  return { ...toolInput, file_path: permissionPathOverride, file: undefined, path: undefined };
}
