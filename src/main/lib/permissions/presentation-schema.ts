import { frinkToolPartName } from '../../../shared/lib/mcp-tool-name';
import { isPermissionPresentation } from '../../../shared/lib/permissions/presentation';
import type { PermissionPresentation } from '../../../shared/types/permissions';

/** Only the canonical registration tool may carry a trusted host-built preview. */
export function isValidPermissionPresentation(
  toolName: string,
  presentation: PermissionPresentation | undefined,
): boolean {
  if (presentation === undefined) return true;
  if (toolName !== frinkToolPartName('frink_register_node')) return false;
  try {
    return isPermissionPresentation(presentation);
  } catch {
    return false;
  }
}
