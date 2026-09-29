import { beforeEach, describe, expect, it } from 'vitest';
import { appStore } from '../jotai-store';
import { codexSpeedAtomFamily } from './codex-speed';

describe('codexSpeedAtomFamily', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to standard — fast bills a credit multiplier, so it must never arrive on', () => {
    expect(appStore.get(codexSpeedAtomFamily('fresh-chat'))).toBe('standard');
  });

  it('keeps chats independent', () => {
    appStore.set(codexSpeedAtomFamily('chat-a'), 'fast');
    expect(appStore.get(codexSpeedAtomFamily('chat-a'))).toBe('fast');
    expect(appStore.get(codexSpeedAtomFamily('chat-b'))).toBe('standard');
  });
});
