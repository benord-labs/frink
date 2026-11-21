import { describe, expect, it, vi } from 'vitest';
import { ApiError, unreachable } from '../relay/error';
import type { Connection } from '../api';
import {
  answerFromAlert,
  answersChat,
  lastAlertAnswer,
  onAlertAnswer,
  PERMISSION_BUTTONS,
  permissionActionFor,
} from './actions';
import { alertedComputer } from './routing';

const alert = alertedComputer(
  {
    type: 'needs-you',
    deviceId: 'phone-on-computer',
    chatId: 'chat',
    subChatId: 'sub',
    permissionRequestId: 'perm_1',
  },
  ['phone-on-computer'],
);
if (!alert) throw new Error('The fixture alert must open');

describe('permissionActionFor', () => {
  it('answers exactly the request the alert names, on its chat', () => {
    expect(permissionActionFor('allow', alert)).toEqual({
      type: 'respondPermission',
      chatId: 'chat',
      subChatId: 'sub',
      requestId: 'perm_1',
      approved: true,
    });
    expect(permissionActionFor('deny', alert)?.approved).toBe(false);
  });

  it('answers nothing for a plain tap, or an alert without a request or a chat session', () => {
    expect(permissionActionFor('expo.modules.notifications.actions.DEFAULT', alert)).toBeNull();
    expect(permissionActionFor('allow', { ...alert, requestId: undefined })).toBeNull();
    expect(permissionActionFor('allow', { ...alert, target: { id: 'chat' } })).toBeNull();
    expect(permissionActionFor('allow', { ...alert, target: 'queue' })).toBeNull();
  });
});

it('asks for the phone to be unlocked and opens Frink for both buttons', () => {
  expect(PERMISSION_BUTTONS.map((button) => button.identifier)).toEqual(['allow', 'deny']);
  for (const { options } of PERMISSION_BUTTONS)
    expect(options).toMatchObject({ opensAppToForeground: true, isAuthenticationRequired: true });
});

const computer = (deviceId: string): Connection => ({
  relay: 'https://relay.example.test',
  route: 'a'.repeat(64),
  key: 'b'.repeat(43),
  token: 'c'.repeat(32),
  deviceId,
  machineName: 'Studio',
  pairedAt: 0,
});
const paired = [computer('other-computer'), computer('phone-on-computer')];
type Send = Parameters<typeof answerFromAlert>[3];

describe('answerFromAlert', () => {
  it('sends one answer, to the computer the alert came from, and stays quiet when it lands', async () => {
    const send = vi.fn<Send>(async () => ({ ok: true }));
    const say = vi.fn();
    await answerFromAlert('allow', alert, paired, send, say);
    expect(send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ requestId: 'perm_1', approved: true }),
      paired[1],
    );
    expect(say).not.toHaveBeenCalled();
  });

  it('sends nothing for a plain tap or a computer this phone no longer has', async () => {
    const send = vi.fn<Send>(async () => ({ ok: true }));
    await answerFromAlert(
      'expo.modules.notifications.actions.DEFAULT',
      alert,
      paired,
      send,
      vi.fn(),
    );
    await answerFromAlert('allow', alert, [paired[0]], send, vi.fn());
    expect(send).not.toHaveBeenCalled();
  });

  it('says plainly why an answer was not sent: already answered, or computer away', async () => {
    const say = vi.fn();
    const failing = (error: Error) => () => Promise.reject(error);
    const closed = new ApiError('This permission request has already closed.', 409);
    await answerFromAlert('deny', alert, paired, failing(closed), say);
    await answerFromAlert('deny', alert, paired, failing(unreachable()), say);
    await answerFromAlert('deny', alert, paired, failing(new TypeError('Network failed')), say);
    expect(say.mock.calls).toEqual([
      ['Your answer wasn’t sent', 'This permission request has already closed.'],
      ['Your answer wasn’t sent', expect.stringMatching(/^Can’t reach your/)],
      ['Your answer wasn’t sent', expect.stringMatching(/couldn’t reach your computer/)],
    ]);
  });
});

it('tells the open chat once its computer accepted the answer, and not after a failure', async () => {
  const heard = vi.fn();
  const stop = onAlertAnswer(heard);
  const answered = { ...alert };
  await answerFromAlert('deny', answered, paired, () => Promise.reject(unreachable()), vi.fn());
  expect(heard).not.toHaveBeenCalled();
  await answerFromAlert('deny', answered, paired, async () => ({ ok: true }), vi.fn());
  expect(heard).toHaveBeenCalledOnce();
  expect(lastAlertAnswer()).toBe(answered);
  stop();
  await answerFromAlert('allow', alert, paired, async () => ({ ok: true }), vi.fn());
  expect(heard).toHaveBeenCalledOnce();
});

it('refreshes only the answered chat, on the computer the alert came from', () => {
  expect(answersChat(alert, 'phone-on-computer', 'chat')).toBe(true);
  expect(answersChat(alert, 'phone-on-computer', 'other-chat')).toBe(false);
  expect(answersChat(alert, 'other-computer', 'chat')).toBe(false);
  expect(answersChat({ ...alert, target: 'queue' }, 'phone-on-computer', 'chat')).toBe(false);
  expect(answersChat(null, 'phone-on-computer', 'chat')).toBe(false);
});
