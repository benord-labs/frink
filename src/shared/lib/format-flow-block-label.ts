/**
 * Human-readable label for a flow block type id (e.g. run_command → Run Command).
 */

export function formatFlowBlockTypeLabel(blockType: string): string {
  return blockType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
