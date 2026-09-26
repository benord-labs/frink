/**
 * tRPC-backed `CommandFetcher` shared by every renderer call site that expands a
 * slash command before sending a message.
 *
 * Reads through the vanilla client rather than the React Query cache on purpose:
 * command bodies are files on disk that change outside the app (external editor,
 * git checkout, another window), and `commands.getContent` has no invalidation
 * path, so a cached read can expand a stale command body into a sent message.
 * Expansion runs once per send, so the extra IPC round trip is not worth caching.
 */

import { trpcClient } from '@/lib/trpc';
import type { CommandFetcher } from '../../../shared/commands/expand-slash-command';

export const commandFetcher: CommandFetcher = {
  listCommands: (projectPath) => trpcClient.commands.list.query({ projectPath }),
  getContent: (path) => trpcClient.commands.getContent.query({ path }).then((r) => r.content),
};
