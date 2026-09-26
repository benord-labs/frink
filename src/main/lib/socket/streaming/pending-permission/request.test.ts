import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron-log', () => ({
  default: { warn: vi.fn() },
}));

import { createPendingPermissionRequestBroker, listPendingPermissionRequests } from './request';

const sendPermissionDismiss = vi.fn();
const sendPermissionRequest = vi.fn();
const broker = createPendingPermissionRequestBroker({
  getExecutionSignal: () => undefined,
  onResponse: vi.fn(),
  sendDismiss: sendPermissionDismiss,
  sendRequest: sendPermissionRequest,
});

describe('pending permission request recovery', () => {
  beforeEach(() => {
    broker.drain();
    sendPermissionDismiss.mockClear();
    sendPermissionRequest.mockClear();
  });

  it('retains the renderer-safe projection until disconnect drains the wait', async () => {
    const pending = broker.request({
      chatId: 'chat-1',
      subChatId: 'subchat-1',
      requestId: 'request-1',
      type: 'bash',
      path: 'echo hello',
      operation: 'bash',
    });

    expect(listPendingPermissionRequests()).toEqual([
      expect.objectContaining({
        requestId: 'request-1',
        subChatId: 'subchat-1',
        type: 'bash',
      }),
    ]);
    expect(sendPermissionRequest).toHaveBeenCalledOnce();

    broker.drain();

    await expect(pending).resolves.toMatchObject({ approved: false, timedOut: true });
    expect(listPendingPermissionRequests()).toEqual([]);
    expect(sendPermissionDismiss).toHaveBeenCalledWith({
      requestId: 'request-1',
      chatId: 'chat-1',
      subChatId: 'subchat-1',
    });
  });
});
