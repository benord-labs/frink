/**
 * Project resolution for flow node blocks (node override vs flow default).
 */

export function getEffectiveNodeProjectId(
  projectId: string,
  flowDefaultProjectId: string | undefined,
): string | undefined {
  const trimmedBlock = projectId.trim();
  if (trimmedBlock !== '') return trimmedBlock;
  return flowDefaultProjectId?.trim() || undefined;
}

export function getNodeProjectFieldError(effectiveProjectId: string | undefined): string | null {
  return (effectiveProjectId?.trim() ?? '') === '' ? 'Select a project.' : null;
}
