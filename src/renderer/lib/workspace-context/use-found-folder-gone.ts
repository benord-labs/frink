import { useEffect, useEffectEvent } from 'react';
import { trpc } from '@/lib/trpc';

/** Once the disk says a linked folder is gone, reads the chat again, so its `missing` flag, which
 *  every surface goes by through useTreeProjects, says so too. */
export function useFoundFolderGone(chatId: string, foundGone: boolean): void {
  const utils = trpc.useUtils();
  const readChatAgain = useEffectEvent(() => void utils.chats.get.invalidate({ id: chatId }));
  useEffect(() => {
    if (foundGone) readChatAgain();
  }, [foundGone, chatId]);
}
