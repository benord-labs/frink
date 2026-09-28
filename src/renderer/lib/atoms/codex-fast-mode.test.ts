import { beforeEach, describe, expect, it } from 'vitest';
import { appStore } from '../jotai-store';
import { codexFastModeAtomFamily } from './codex-fast-mode';

describe('codexFastModeAtomFamily', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to off — the tier bills a credit multiplier, so it must never arrive on', () => {
    expect(appStore.get(codexFastModeAtomFamily('fresh-chat'))).toBe(false);
  });

  it('keeps chats independent', () => {
    appStore.set(codexFastModeAtomFamily('chat-a'), true);
    expect(appStore.get(codexFastModeAtomFamily('chat-a'))).toBe(true);
    expect(appStore.get(codexFastModeAtomFamily('chat-b'))).toBe(false);
  });
});
