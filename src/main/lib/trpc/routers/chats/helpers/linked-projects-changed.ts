import { BrowserWindow } from 'electron';

/** Tells every window to refetch the chat; the payload is mirrored by useLinkedProjectsSync. Run
 * after anything that changes a chat's links, or a linked project's name, has committed. It sends
 * to the windows itself, as broadcastChatNameUpdated does, so callers such as the MCP server pull
 * in nothing else to use it. */
export function broadcastLinkedProjectsChanged(chatId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('chats:linked-projects-changed', { chatId });
  }
}
