import { MessageSquarePlus } from 'lucide-react';
import type { ReactElement } from 'react';
import { ContextMenuItem } from '@/components/ui/context-menu';
import { useAddToChat } from '@/lib/agent-chat/composer-input/add-to-chat-context';
import type { SelectionStore } from '../../use-multi-select';

/** Add to Chat: the whole selection in a batch, else this node; hidden when the tree has no chat. */
export function AddToChatItem({
  node,
  isBatch,
  count,
  store,
}: {
  node: { path: string; type: 'file' | 'folder' };
  isBatch: boolean;
  count: number;
  store: SelectionStore;
}): ReactElement | null {
  const addToChat = useAddToChat();
  if (!addToChat) return null;
  const add = () =>
    addToChat(
      isBatch
        ? store.getSelectedItems().map(({ path, type }) => ({ path, type }))
        : [{ path: node.path, type: node.type }],
    );
  return (
    <ContextMenuItem onClick={add}>
      <MessageSquarePlus className="mr-2 size-4" />
      {isBatch ? `Add ${count} to Chat` : 'Add to Chat'}
    </ContextMenuItem>
  );
}
