import { isPermissionPresentation } from '../../../shared/lib/permissions/presentation';
import type { PermissionPresentation } from '../../../shared/types/permissions';

/** Only the canonical registration tool may carry a trusted host-built preview. */
export function isValidPermissionPresentation(
  toolName: string,
  presentation: PermissionPresentation | undefined,
): boolean {
  if (presentation === undefined) return true;
  if (toolName !== 'mcp__frink_dynamic_chat__frink_register_node') return false;
  try {
    return isPermissionPresentation(presentation);
  } catch {
    return false;
  }
}
