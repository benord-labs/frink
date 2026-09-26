import { isMarkdownPath } from '../../../../shared/markdown-extensions';

type MarkdownPreviewToggleShortcutInput = {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isEditorOpen: boolean;
  /** Keyboard event target is inside the editor panel (avoids firing from chat, etc.) */
  inPanel: boolean;
  /** Active file path for markdown extension check */
  filePath: string | undefined;
};

/**
 * Cmd/Ctrl+Alt+V — toggle rendered markdown preview when focus is in the code editor panel.
 * Shift must be unambiguously off so we do not collide with other modified-V chords.
 */
export function isMarkdownPreviewToggleShortcut({
  key,
  code,
  metaKey,
  ctrlKey,
  shiftKey,
  altKey,
  isEditorOpen,
  inPanel,
  filePath,
}: MarkdownPreviewToggleShortcutInput): boolean {
  if (!isEditorOpen || !inPanel) return false;
  const mod = metaKey || ctrlKey;
  if (!mod || !altKey || shiftKey) return false;
  if (code !== 'KeyV' && key.toLowerCase() !== 'v') return false;
  if (!filePath || !isMarkdownPath(filePath)) return false;
  return true;
}
