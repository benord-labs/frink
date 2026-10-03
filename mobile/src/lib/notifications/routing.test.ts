import { expect, it } from 'vitest';
import { alertedComputer } from './routing';

const paired = ['phone-on-mac-a', 'phone-on-mac-b'];

it('opens only validated alerts from a paired computer, including one not shown now', () => {
  const data = {
    type: 'session-completed',
    deviceId: 'phone-on-mac-b',
    chatId: 'chat',
    subChatId: 'sub',
  };
  expect(alertedComputer(data, paired)).toEqual({
    deviceId: 'phone-on-mac-b',
    target: { id: 'chat', subChatId: 'sub' },
  });
  expect(alertedComputer({ ...data, deviceId: 'forgotten' }, paired)).toBeNull();
  expect(alertedComputer({ ...data, chatId: 7 }, paired)).toBeNull();
  expect(alertedComputer({ url: 'https://evil.example' }, paired)).toBeNull();
});

it('opens the chat that needs you, or the Queue for a task without one', () => {
  const data = { type: 'needs-you', deviceId: 'phone-on-mac-a', chatId: 'chat', subChatId: 'sub' };
  expect(alertedComputer(data, paired)?.target).toEqual({ id: 'chat', subChatId: 'sub' });
  expect(alertedComputer({ ...data, subChatId: undefined }, paired)?.target).toEqual({
    id: 'chat',
  });
  expect(alertedComputer({ type: 'needs-you', deviceId: 'phone-on-mac-a' }, paired)?.target).toBe(
    'queue',
  );
  expect(alertedComputer({ ...data, chatId: '' }, paired)).toBeNull();
});
