import { BrowserWindow } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'home' ? '/tmp/frink-test-home' : '/tmp') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { onStop, sendExecuteCompleteDirect, sendStop } from './client';

describe('socket client', () => {
  describe('sendExecuteCompleteDirect', () => {
    it('broadcasts finalParts with a main-minted terminal identity', () => {
      const mockWin = {
        isDestroyed: () => false,
        webContents: { isCrashed: () => false, send: vi.fn() },
      };
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
        mockWin,
      ] as unknown as BrowserWindow[]);

      const payload = {
        chatId: 'chat-1',
        subChatId: 'sub-1',
        assistantMessageId: 'assistant-1',
        sessionId: 'session-1',
        finalParts: [
          {
            type: 'tool-frink-plan',
            toolCallId: 'frink-plan-1',
            input: {
              planId: 'frink-plan-1',
              summary: 'Persist plans on refresh',
              planPath: '/tmp/persist.plan.md',
              status: 'approved',
            },
          },
        ],
      };

      sendExecuteCompleteDirect(payload);

      expect(mockWin.webContents.send).toHaveBeenCalledWith(
        'socket:execute-complete',
        expect.objectContaining({
          ...payload,
          streamEpoch: expect.any(String),
          continuesWakeHold: false,
          observerOwned: true,
        }),
      );
    });
  });

  describe('event callback subscribers', () => {
    const unsubs: Array<() => void> = [];

    afterEach(() => {
      while (unsubs.length > 0) {
        unsubs.pop()?.();
      }
    });

    it('invokes every onStop subscriber', () => {
      const first = vi.fn();
      const second = vi.fn();
      unsubs.push(onStop(first));
      unsubs.push(onStop(second));

      const payload = { chatId: 'c1', subChatId: 's1' };
      sendStop(payload);

      expect(first).toHaveBeenCalledWith(payload);
      expect(second).toHaveBeenCalledWith(payload);
    });

    it('unsubscribe removes only that listener', () => {
      const first = vi.fn();
      const second = vi.fn();
      const offFirst = onStop(first);
      unsubs.push(offFirst);
      unsubs.push(onStop(second));

      sendStop({ chatId: 'c1', subChatId: 's1' });
      offFirst();
      sendStop({ chatId: 'c1', subChatId: 's1' });

      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(2);
    });

    it('still invokes later listeners when an earlier one throws', () => {
      const throwing = vi.fn(() => {
        throw new Error('listener boom');
      });
      const after = vi.fn();
      unsubs.push(onStop(throwing));
      unsubs.push(onStop(after));

      expect(() => sendStop({ chatId: 'c1', subChatId: 's1' })).not.toThrow();

      expect(throwing).toHaveBeenCalledTimes(1);
      expect(after).toHaveBeenCalledTimes(1);
    });
  });
});
