import { useCallback, useMemo, useState } from 'react';
import { readDraftSubChatId } from '../drafts';

/** The new chat's first sub-chat id, known before the chat exists so pastes land in its folder.
 *  A stored draft keeps its id; `rotate` starts a fresh one once a chat is created from it. */
export function useNewChatSubChatId(draftKey: string) {
  const [fresh, setFresh] = useState(() => crypto.randomUUID());
  const subChatId = useMemo(() => readDraftSubChatId(draftKey) ?? fresh, [draftKey, fresh]);
  const rotate = useCallback(() => setFresh(crypto.randomUUID()), []);
  return { subChatId, rotate };
}
