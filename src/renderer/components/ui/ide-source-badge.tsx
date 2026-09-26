/** IDE source types for resource origin */
export type IdeSourceType = 'cursor' | 'claude-code' | 'frink';

export const SOURCE_LABELS = {
  cursor: 'Cursor',
  'claude-code': 'Claude',
  frink: 'Frink',
} satisfies Record<IdeSourceType, string>;
