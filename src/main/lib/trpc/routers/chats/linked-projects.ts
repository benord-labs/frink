import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { getDatabase } from '../../../db';
import {
  type LinkRefusal,
  linkProjectToChat,
  unlinkProjectFromChat,
} from '../../../db/repos/chat-linked-projects';
import { getProjectById } from '../../../db/repos/projects';
import { broadcastToRenderer } from '../../../socket/client';
import { publicProcedure, router } from '../../index';

const linkInput = z.object({ chatId: z.string().min(1), projectId: z.string().min(1) });

type BadRequest = Exclude<LinkRefusal, 'chat-not-found' | 'project-not-found'>;

/** Each message is true for every case its reason covers: an overlap runs both ways and counts the
 * chat's worktree, and a root folder may also be a drive or `~/.ssh`. A message that names the
 * project brings its own fallback, cased for where the name sits in the sentence. */
const REFUSALS: Record<BadRequest, (name: string | undefined) => string> = {
  'general-chat': () => 'Only chats in a project can link other projects.',
  'virtual-chat': () => "Chats in a virtual folder can't link projects.",
  'main-project': () => "This is already the chat's project.",
  'virtual-folder': () => 'Virtual folders have no files to link.',
  'root-folder': (name = 'This project') =>
    `${name} is or contains your home folder, a whole drive or a protected folder like ~/.ssh, so it can't be linked.`,
  'folder-missing': (name = 'this project') => `Can't find ${name}'s folder.`,
  'overlaps-main': (name = 'This project') =>
    `${name} is inside this chat's project or worktree, or contains one of them, so it can't be linked.`,
};

async function refusalError(reason: LinkRefusal, projectId: string): Promise<TRPCError> {
  if (reason === 'chat-not-found' || reason === 'project-not-found') {
    const message =
      reason === 'chat-not-found' ? 'Chat not found' : 'This project is no longer in Frink.';
    return new TRPCError({ code: 'NOT_FOUND', message });
  }
  // The project was there a moment ago; the fallbacks only cover it being removed since.
  const name = (await getProjectById(getDatabase(), projectId))?.name;
  return new TRPCError({ code: 'BAD_REQUEST', message: REFUSALS[reason](name) });
}

/** Tells every window to refetch the chat; the payload is mirrored by useLinkedProjectsSync. */
function broadcastLinkedProjectsChanged(chatId: string): void {
  broadcastToRenderer('chats:linked-projects-changed', { chatId });
}

/** Links and unlinks projects on a chat. No agent session restarts: a link changes no spawn
 * option. */
export const linkedProjectsRouter = router({
  linkProject: publicProcedure.input(linkInput).mutation(async ({ input }) => {
    const result = linkProjectToChat(getDatabase(), input.chatId, input.projectId);
    if (!result.ok) throw await refusalError(result.reason, input.projectId);
    broadcastLinkedProjectsChanged(input.chatId);
    return { success: true as const };
  }),

  /** Unlinking a project that is not linked changes nothing and tells no window. */
  unlinkProject: publicProcedure.input(linkInput).mutation(({ input }) => {
    if (unlinkProjectFromChat(getDatabase(), input.chatId, input.projectId)) {
      broadcastLinkedProjectsChanged(input.chatId);
    }
    return { success: true as const };
  }),
});
