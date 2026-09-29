import { describe, expect, it } from 'vitest';
import type { MobileChatSummary } from '../../../../src/shared/types/remote/mobile';
import {
  actionEnabled,
  chatPollInterval,
  composerMode,
} from './chat-state';

describe('composerMode', () => {
  it('sends when idle and ready, and says so when the Mac is not ready', () => {
    expect(composerMode('idle', true, true)).toBe('send');
    expect(composerMode('idle', true, false)).toBe('unavailable');
  });

  it('steers typed text into a running turn and stops it when the box is empty', () => {
    expect(composerMode('running', true, true)).toBe('steer');
    expect(composerMode('running', false, true)).toBe('stop');
  });

  it('only offers Stop while Frink waits on background work, even with text typed', () => {
    expect(composerMode('background', true, true)).toBe('stop');
    expect(composerMode('background', false, true)).toBe('stop');
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
