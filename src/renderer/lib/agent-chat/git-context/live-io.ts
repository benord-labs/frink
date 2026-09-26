import { toast } from 'sonner';
import { trpcClient } from '../../trpc';
import type { GitContextIo } from '.';

export const liveGitContextIo: GitContextIo = {
  getPrContext: (chatId) => trpcClient.chats.getPrContext.query({ chatId }),
  notifyError: (message) => toast.error(message, { position: 'top-center' }),
};
