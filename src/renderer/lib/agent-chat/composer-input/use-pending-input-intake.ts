import { useAtomValue, useStore } from 'jotai';
import { type RefObject, useEffect } from 'react';
import { toast } from 'sonner';
import { isWholeMentionId } from '../../../../shared/lib/mentions/mention-grammar';
import { pickedPathMention } from '../../../../shared/lib/mentions/parse-mention';
import type { FileMentionOption } from '@/lib/mentions/agents-mentions-types';
import { type PendingPath, pendingComposerInputAtomFamily } from './pending-input';

/** The parts of the composer's mentions editor the intake uses. */
type Editor = {
  focus: () => void;
  insertMention: (option: FileMentionOption) => void;
  getValue: () => string;
};

type Params = {
  /** The chat the input was sent to: the chat id, or the new-chat form's terminal id. */
  chatId: string;
  addPastedText: (text: string, options: { label: string; kind: 'terminal' }) => Promise<void>;
  editorRef: RefObject<Editor | null>;
  /** Whether the composer is on screen; when it appears, paths that waited for it are added. */
  composerShown?: boolean;
};

/**
 * One mention chip per path, skipping paths already in the composer or added earlier in this drain.
 * A name the token grammar would cut short is not added: the chat would get a different path.
 */
function insertPaths(editor: Editor, items: PendingPath[]) {
  editor.focus();
  const text = editor.getValue();
  const added = new Set<string>();
  for (const { path, type } of items) {
    const option = pickedPathMention(type, path);
    if (!isWholeMentionId(option.id)) {
      toast.error(
        `Couldn't add ${option.label}: its name has square brackets a message can't hold. Type its path instead.`,
      );
    } else if (!added.has(option.id) && !text.includes(`@[${option.id}]`)) {
      added.add(option.id);
      editor.insertMention(option);
    }
  }
}

/** Takes what was sent to this chat's composer: text as a labelled chip, paths as mention chips. */
export function usePendingInputIntake({
  chatId,
  addPastedText,
  editorRef,
  composerShown = true,
}: Params) {
  const store = useStore();
  const pendingAtom = pendingComposerInputAtomFamily(chatId);
  const pending = useAtomValue(pendingAtom);

  useEffect(() => {
    const editor = editorRef.current;
    // Read the live queue, not the render's copy, and remove only what this run takes.
    const queued = store.get(pendingAtom);
    // Paths need the editor; with none mounted they wait in the queue until the composer appears.
    const ready = editor ? queued : queued.filter((item) => item.kind === 'text');
    if (ready.length === 0) return;
    store.set(pendingAtom, (live) => live.filter((item) => !ready.includes(item)));
    const paths = ready.flatMap((item) => (item.kind === 'paths' ? item.items : []));
    if (editor && paths.length > 0) insertPaths(editor, paths);
    for (const item of ready) {
      if (item.kind === 'paths') continue;
      addPastedText(item.text, { label: item.label, kind: 'terminal' })
        .then(() => editorRef.current?.focus())
        .catch(() => toast.error("Couldn't add the terminal output"));
    }
    // composerShown is a trigger only: the editor it mounts is read through editorRef.
  }, [pending, pendingAtom, store, addPastedText, editorRef, composerShown]);
}
