// @vitest-environment happy-dom

import { RESET } from 'jotai/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  autoModePerChatAtomFamily,
  lastSelectedModelIdAtomFamily,
} from '../../features/agents/atoms';
import { appStore } from '../jotai-store';
import { writeComposerCache } from './atom-family-factory';
import { codexSpeedAtomFamily } from './codex-speed';
import { collectComposerImport } from './composer-import';
import { registerComposerPersister } from './composer-persistence';
import { extendedThinkingEnabledAtom } from './index';

const chat = vi.fn();
const thinking = vi.fn();
let unregister: () => void;

describe('main-backed composer atoms', () => {
  beforeEach(() => {
    localStorage.clear();
    chat.mockReset();
    thinking.mockReset();
    unregister = registerComposerPersister({ chat, thinking });
  });

  afterEach(() => unregister());

  it('sends a user change to main and shows it immediately', () => {
    appStore.set(lastSelectedModelIdAtomFamily('c1'), 'opus-4.8');
    expect(appStore.get(lastSelectedModelIdAtomFamily('c1'))).toBe('opus-4.8');
    expect(chat).toHaveBeenCalledWith('c1', { modelId: 'opus-4.8' });

    appStore.set(codexSpeedAtomFamily('c1'), 'fast');
    expect(chat).toHaveBeenLastCalledWith('c1', { codexSpeed: 'fast' });
  });

  it('does not re-send a value the chat already has', () => {
    appStore.set(autoModePerChatAtomFamily('c1'), true); // the default
    expect(chat).not.toHaveBeenCalled();
  });

  it('mirrors main’s echo without writing it back (no echo loop)', () => {
    writeComposerCache('c1', { modelId: 'haiku', autoMode: false });
    expect(appStore.get(lastSelectedModelIdAtomFamily('c1'))).toBe('haiku');
    expect(appStore.get(autoModePerChatAtomFamily('c1'))).toBe(false);
    expect(chat).not.toHaveBeenCalled();
  });

  it('routes Thinking through main, with RESET meaning on', () => {
    appStore.set(extendedThinkingEnabledAtom, false);
    expect(thinking).toHaveBeenLastCalledWith(false);
    appStore.set(extendedThinkingEnabledAtom, RESET);
    expect(appStore.get(extendedThinkingEnabledAtom)).toBe(true);
    expect(thinking).toHaveBeenLastCalledWith(true);
  });

  it('collects this window’s old choices for the one-time import', () => {
    writeComposerCache('import-a', { modelId: 'opus-4.8', codexSpeed: 'fast' });
    writeComposerCache('import-b', { autoMode: false });

    const { entries } = collectComposerImport();
    expect(entries).toContainEqual({
      chatId: 'import-a',
      modelId: 'opus-4.8',
      codexSpeed: 'fast',
    });
    expect(entries).toContainEqual({ chatId: 'import-b', autoMode: false });
  });

  it('imports Thinking only when the user had actually set it', () => {
    expect(collectComposerImport()).not.toHaveProperty('thinkingEnabled');
    localStorage.setItem('preferences:extended-thinking-enabled', 'false');
    appStore.set(extendedThinkingEnabledAtom, false);
    expect(collectComposerImport().thinkingEnabled).toBe(false);
  });
});
