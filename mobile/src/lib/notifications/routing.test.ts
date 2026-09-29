import { expect, it } from 'vitest';
import { notificationChat } from './routing';
it('opens only validated notifications for the current pairing', () => {
  const data = { type: 'session-completed', deviceId: 'phone', chatId: 'chat', subChatId: 'sub' };
  expect(notificationChat(data, 'phone')).toEqual({ id: 'chat', subChatId: 'sub' });
  expect(notificationChat(data, 'other-phone')).toBeNull();
  expect(notificationChat({ ...data, chatId: 7 }, 'phone')).toBeNull();
  expect(notificationChat({ url: 'https://evil.example' }, 'phone')).toBeNull();
});
