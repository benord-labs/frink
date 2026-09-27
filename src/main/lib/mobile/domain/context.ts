import { BrowserWindow } from 'electron';
import { chatsRouter } from '../../trpc/routers/chats';
import { flowsRouter } from '../../trpc/routers/flows';
import { socketRouter } from '../../trpc/routers/socket';
import { tasksRouter } from '../../trpc/routers/tasks';
import { MobileApiError } from './errors';
export { MobileApiError } from './errors';

const context = { getWindow: () => null };
export const mobileCallers = {
  chats: chatsRouter.createCaller(context),
  flows: flowsRouter.createCaller(context),
  socket: socketRouter.createCaller(context),
  tasks: tasksRouter.createCaller(context),
};

export function executionReady(): boolean {
  return BrowserWindow.getAllWindows().some(
    (window) =>
      !window.isDestroyed() &&
      !window.webContents.isDestroyed() &&
      !window.webContents.isCrashed() &&
      !window.webContents.isLoadingMainFrame() &&
      Boolean(window.webContents.getURL()),
  );
}

export function requireExecutionReady(): void {
  if (!executionReady()) throw new MobileApiError(409, 'Open Frink on your computer to continue.');
}

export async function requireChat(chatId: string, subChatId?: string) {
  const chat = await mobileCallers.chats.get({ id: chatId });
  if (!chat || chat.archivedAt) throw new MobileApiError(404, 'Chat not found.');
  const subChat = subChatId ? chat.subChats.find((sub) => sub.id === subChatId) : chat.subChats[0];
  if (!subChat) throw new MobileApiError(404, 'Chat session not found.');
  return { chat, subChat };
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
