import { useStore } from 'jotai';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { type PendingPath, pendingComposerInputAtomFamily } from './pending-input';

type AddToChat = (items: PendingPath[]) => void;

const AddToChatContext = createContext<AddToChat | undefined>(undefined);

/**
 * Gives a file tree the Add to Chat action of the chat it belongs to. With no chat, or an empty
 * split pane, there is no composer to receive paths, so the tree gets no action.
 */
export function AddToChatProvider({
  chatId,
  children,
}: {
  chatId?: string | null;
  children: ReactNode;
}) {
  const store = useStore();
  const addToChat = useMemo<AddToChat | undefined>(() => {
    if (!chatId || chatId.startsWith('empty-')) return undefined;
    const pendingAtom = pendingComposerInputAtomFamily(chatId);
    return (items) => store.set(pendingAtom, (prev) => [...prev, { kind: 'paths', items }]);
  }, [chatId, store]);
  return <AddToChatContext.Provider value={addToChat}>{children}</AddToChatContext.Provider>;
}

/** Queues paths for this tree's chat composer as mention chips; undefined when there is none. */
export function useAddToChat(): AddToChat | undefined {
  return useContext(AddToChatContext);
}
