import { beforeEach, describe, expect, it } from 'vitest';
import { appStore } from '../jotai-store';
import { codexFastModeAtomFamily, codexFastModeSetting } from './codex-fast-mode';

const SUPPORTED = 'codex-gpt-5.6-sol-medium';
const NO_TIER = 'codex-gpt-5.4-mini-medium';

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

describe('codexFastModeSetting', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('sends the flag only when the chat has Fast on', () => {
    expect(codexFastModeSetting('chat-1', SUPPORTED)).toEqual({ codexFastMode: false });
    appStore.set(codexFastModeAtomFamily('chat-1'), true);
    expect(codexFastModeSetting('chat-1', SUPPORTED)).toEqual({ codexFastMode: true });
  });

  it('omits the flag entirely for models with no priority tier', () => {
    // A chat left on Fast then switched to a tier-less model must not ask for a tier at all.
    appStore.set(codexFastModeAtomFamily('chat-2'), true);
    expect(codexFastModeSetting('chat-2', NO_TIER)).toEqual({});
  });

  it('is keyed by the same chat id the model is, so sub-chats inherit one value', () => {
    // The transport reads BOTH the model and Fast under `config.chatId` (the parent chat), so a
    // sub-chat turn bills at the parent's setting. Pinning the shared key stops a later change from
    // keying Fast per sub-chat, which would let one sub-chat spend at 2.5x while the switch the user
    // can see — the parent's — reads off.
    appStore.set(codexFastModeAtomFamily('parent-chat'), true);
    expect(codexFastModeSetting('parent-chat', SUPPORTED)).toEqual({ codexFastMode: true });
  });

  it('omits the flag for a stale picker id that is no longer in the catalog', () => {
    // A dropped id (a catalog change, or a cross-provider leftover) resolves to no multiplier, so
    // the UI sends nothing rather than betting the executor's fallback slug happens to be free.
    appStore.set(codexFastModeAtomFamily('chat-stale'), true);
    expect(codexFastModeSetting('chat-stale', 'codex-gpt-5.3-codex-high')).toEqual({});
  });

  it('omits the flag for non-codex models and when there is no chat yet', () => {
    appStore.set(codexFastModeAtomFamily('chat-3'), true);
    expect(codexFastModeSetting('chat-3', 'opus-4.8')).toEqual({});
    expect(codexFastModeSetting('chat-3', 'cursor-codex-5.3-high')).toEqual({});
    expect(codexFastModeSetting('chat-3', undefined)).toEqual({});
    expect(codexFastModeSetting(undefined, SUPPORTED)).toEqual({});
  });
});
