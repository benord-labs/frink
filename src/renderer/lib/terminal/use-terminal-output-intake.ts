import { useAtomValue, useStore } from 'jotai';
import { type RefObject, useEffect } from 'react';
import { toast } from 'sonner';
import { pendingTerminalOutputAtomFamily } from './pending-output';

type Params = {
  /** The chat whose terminal sends: the chat id, or the new-chat form's terminal id. */
  chatId: string;
  addPastedText: (text: string, options: { label: string; kind: 'terminal' }) => Promise<void>;
  editorRef: RefObject<{ focus: () => void } | null>;
};

/** Takes the output this chat's terminal sent and adds it to the composer as a labelled chip. */
export function useTerminalOutputIntake({ chatId, addPastedText, editorRef }: Params) {
  const store = useStore();
  const pendingAtom = pendingTerminalOutputAtomFamily(chatId);
  const pending = useAtomValue(pendingAtom);

  useEffect(() => {
    if (!pending) return;
    store.set(pendingAtom, null);
    addPastedText(pending.text, { label: pending.label, kind: 'terminal' })
      .then(() => editorRef.current?.focus())
      .catch(() => toast.error("Couldn't add the terminal output"));
  }, [pending, pendingAtom, store, addPastedText, editorRef]);
}
