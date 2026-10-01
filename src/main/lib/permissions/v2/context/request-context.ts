import { PATH_TOOLS } from '../../../../../shared/types/permissions';

export function buildPermissionDecisionInput(
  toolName: string,
  toolInput: Record<string, unknown>,
  permissionPathOverride?: string,
): Record<string, unknown> {
  if (!permissionPathOverride || !PATH_TOOLS.has(toolName)) return toolInput;
  return { ...toolInput, file_path: permissionPathOverride, file: undefined, path: undefined };
}
