/** Where a menu bar row leads when clicked: a chat, or the Work Queue for waits that are not one chat. */
export type TrayTarget = { chatId: string; subChatId?: string } | { view: 'workqueue' };
