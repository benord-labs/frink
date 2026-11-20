import type { MobileRequest } from '../../../../shared/types/remote/mobile';
import { readMobileChat } from '../domain/chat';
import { MobileApiError } from '../domain/errors';
import type { MobileStreamHub } from './hub';

/** Where a request's live chat watches go: the running hub and the channel the request came over. */
export type MobileWatchContext = { streams: MobileStreamHub; channelId?: string };

export async function watchMobileChat(
  input: Extract<MobileRequest, { type: 'watchChat' }>,
  context: MobileWatchContext | undefined,
) {
  const read = (subChatId?: string) =>
    readMobileChat({ type: 'chat', id: input.chatId, subChatId });
  const watched =
    context?.channelId && (await context.streams.watch(context.channelId, read, input.subChatId));
  // Not 400: the phone reads a 400 here as a desktop without live updates, and stops asking.
  if (!watched) throw new MobileApiError(409, 'Live updates need an open connection. Try again.');
  return watched;
}

export function unwatchMobileChat(
  input: Extract<MobileRequest, { type: 'unwatchChat' }>,
  context: MobileWatchContext | undefined,
) {
  if (context?.channelId) context.streams.unwatch(context.channelId, input.sub);
  return { ok: true as const };
}
