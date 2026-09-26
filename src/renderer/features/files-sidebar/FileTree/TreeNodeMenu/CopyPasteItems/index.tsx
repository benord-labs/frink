import { ClipboardPaste, Copy } from 'lucide-react';
import type { ReactElement } from 'react';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { Hint } from '../Hint';

/** Internal clipboard copy/paste — single-selection only. */
export function CopyPasteItems({
  show,
  hasCopiedItem,
  copyHint,
  pasteHint,
  onCopyItem,
  onPasteItem,
}: {
  show: boolean;
  hasCopiedItem?: boolean;
  copyHint: string;
  pasteHint: string;
  onCopyItem: () => void;
  onPasteItem: () => void;
}): ReactElement | null {
  if (!show) return null;
  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={onCopyItem}>
        <Copy className="mr-2 size-4" />
        Copy
        <Hint text={copyHint} />
      </ContextMenuItem>
      <ContextMenuItem onClick={onPasteItem} disabled={!hasCopiedItem}>
        <ClipboardPaste className="mr-2 size-4" />
        Paste
        <Hint text={pasteHint} />
      </ContextMenuItem>
    </>
  );
}
