import { expect, it } from 'vitest';
import { notificationTarget } from './routing';
it('opens only validated notifications for the current pairing', () => {
  const data = { type: 'session-completed', deviceId: 'phone', chatId: 'chat', subChatId: 'sub' };
  expect(notificationTarget(data, 'phone')).toEqual({ id: 'chat', subChatId: 'sub' });
  expect(notificationTarget(data, 'other-phone')).toBeNull();
  expect(notificationTarget({ ...data, chatId: 7 }, 'phone')).toBeNull();
  expect(notificationTarget({ url: 'https://evil.example' }, 'phone')).toBeNull();
});

it('opens the chat that needs you, or the Queue for a task without one', () => {
  const data = { type: 'needs-you', deviceId: 'phone', chatId: 'chat', subChatId: 'sub' };
  expect(notificationTarget(data, 'phone')).toEqual({ id: 'chat', subChatId: 'sub' });
  expect(notificationTarget({ ...data, subChatId: undefined }, 'phone')).toEqual({ id: 'chat' });
  expect(notificationTarget({ type: 'needs-you', deviceId: 'phone' }, 'phone')).toBe('queue');
  expect(notificationTarget(data, 'other-phone')).toBeNull();
  expect(notificationTarget({ ...data, chatId: '' }, 'phone')).toBeNull();
});
