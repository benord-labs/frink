import { describe, expect, it } from 'vitest';
import type { MobileChatSummary } from '@frink/shared/types/remote/mobile';
import { acceptsMessage, actionEnabled, chatPollInterval, composerMode } from './chat-state';

describe('composerMode', () => {
  const typed = { text: 'Also this', files: 0 };
  const empty = { text: ' ', files: 0 };

  it('sends when idle and ready, and says so when the Mac is not ready', () => {
    expect(composerMode('idle', typed, true, false)).toBe('send');
    expect(composerMode('idle', typed, false, false)).toBe('unavailable');
  });

  it('steers typed text into a running turn and stops it when the box is empty', () => {
    expect(composerMode('running', typed, true, false)).toBe('steer');
    expect(composerMode('running', { text: '', files: 1 }, true, false)).toBe('stop');
  });

  it('sends into a background wait, as desktop does, and stops it when the box is empty', () => {
    expect(composerMode('background', typed, true, false)).toBe('send');
    expect(composerMode('background', { text: '', files: 1 }, true, false)).toBe('send');
    expect(composerMode('background', empty, true, false)).toBe('stop');
    expect(composerMode('background', typed, false, false)).toBe('stop');
  });

  it('only offers Stop while a Flow step waits on background work', () => {
    expect(composerMode('background', typed, true, true)).toBe('stop');
    expect(composerMode('background', { text: '', files: 1 }, true, true)).toBe('stop');
  });
});

describe('acceptsMessage', () => {
  it('takes files and text when idle or in a plain chat’s background wait, with the Mac ready', () => {
    expect(acceptsMessage('idle', true, false)).toBe(true);
    expect(acceptsMessage('background', true, false)).toBe(true);
    expect(acceptsMessage('background', false, false)).toBe(false);
    expect(acceptsMessage('background', true, true)).toBe(false);
    expect(acceptsMessage('running', true, false)).toBe(false);
  });
});

it('polls busy chats faster than idle ones', () => {
  expect(chatPollInterval('running')).toBe(2000);
  expect(chatPollInterval('background')).toBe(2000);
  expect(chatPollInterval('idle')).toBe(4000);
  expect(chatPollInterval(undefined)).toBe(4000);
});

describe('actionEnabled', () => {
  const draft = { text: '', files: 0, uploading: false, failed: false };

  it('always allows Stop, and a steer only with text', () => {
    expect(actionEnabled('stop', draft)).toBe(true);
    expect(actionEnabled('steer', { ...draft, files: 1 })).toBe(false);
    expect(actionEnabled('steer', { ...draft, text: 'Also this' })).toBe(true);
  });

  it('sends text or files once every file has uploaded', () => {
    expect(actionEnabled('send', draft)).toBe(false);
    expect(actionEnabled('send', { ...draft, files: 1 })).toBe(true);
    expect(actionEnabled('send', { ...draft, text: 'Hi', uploading: true })).toBe(false);
    expect(actionEnabled('send', { ...draft, text: 'Hi', failed: true })).toBe(false);
    expect(actionEnabled('unavailable', { ...draft, text: 'Hi' })).toBe(false);
  });
});
