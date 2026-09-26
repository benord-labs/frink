/**
 * Curated Lucide icon keys for custom flow nodes (manifest `icon` field).
 * Renderer maps these to named Lucide imports — no dynamic `icons` barrel (tree-shaking safe).
 */
export const CUSTOM_NODE_ICON_KEY_LIST = [
  'activity',
  'bell',
  'bot',
  'box',
  'calendar',
  'check-circle',
  'clipboard',
  'cloud',
  'code',
  'database',
  'file-code',
  'file-text',
  'folder',
  'git-branch',
  'globe',
  'hammer',
  'inbox',
  'layers',
  'mail',
  'message-square',
  'package',
  'search',
  'send',
  'server',
  'shield',
  'sparkles',
  'terminal',
  'webhook',
  'workflow',
  'wrench',
  'zap',
] as const;

/** Union of allowlisted icon keys — must match `CUSTOM_BLOCK_ICONS` in FlowBlockIcon.tsx. */
export type CustomNodeIconKey = (typeof CUSTOM_NODE_ICON_KEY_LIST)[number];

const CUSTOM_NODE_ICON_KEYS = new Set<string>(CUSTOM_NODE_ICON_KEY_LIST);

export function isKnownCustomNodeIconKey(key: string): boolean {
  return CUSTOM_NODE_ICON_KEYS.has(key.trim().toLowerCase());
}
