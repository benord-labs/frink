import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_NOT_READY_TOAST_MESSAGE_SEND,
  ACCOUNT_NOT_READY_TOAST_MESSAGE_START_CHAT,
  showAccountNotReadyToast,
} from './show-account-not-ready-toast';
// Deliberately from the barrel: the call sites import through it, so a missing re-export
// would silently disable the gate's polling recovery.
import { accountGateRefetchInterval } from './index';

const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock('sonner', () => ({
  toast: { error: toastErrorMock },
}));

describe('showAccountNotReadyToast', () => {
  beforeEach(() => {
    toastErrorMock.mockReset();
  });

  it('shows Connect and routes action to add mode when there is no unauthenticated account row', () => {
    const setPending = vi.fn();
    showAccountNotReadyToast(undefined, setPending);

    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith(
      ACCOUNT_NOT_READY_TOAST_MESSAGE_SEND,
      expect.objectContaining({
        action: expect.objectContaining({ label: 'Connect' }),
      }),
    );

    const [, options] = toastErrorMock.mock.calls[0] as [
      string,
      { action: { onClick: () => void } },
    ];
    options.action.onClick();
    expect(setPending).toHaveBeenCalledWith({
      mode: 'add',
      accountLabel: '',
      returnToSettings: false,
    });
  });

  it('shows Reconnect and routes action to reauth with label when unauthAccount is present (provider-agnostic)', () => {
    const setPending = vi.fn();
    showAccountNotReadyToast({ label: 'Team Claude', type: 'claude-code' }, setPending);

    expect(toastErrorMock).toHaveBeenCalledWith(
      ACCOUNT_NOT_READY_TOAST_MESSAGE_SEND,
      expect.objectContaining({
        action: expect.objectContaining({ label: 'Reconnect' }),
      }),
    );

    const [, options] = toastErrorMock.mock.calls[0] as [
      string,
      { action: { onClick: () => void } },
    ];
    options.action.onClick();
    expect(setPending).toHaveBeenCalledWith({
      mode: 'reauth',
      accountLabel: 'Team Claude',
      returnToSettings: false,
    });
  });

  it('uses custom message when options.message is set (e.g. new-chat composer)', () => {
    const setPending = vi.fn();
    showAccountNotReadyToast(undefined, setPending, {
      message: ACCOUNT_NOT_READY_TOAST_MESSAGE_START_CHAT,
    });

    expect(toastErrorMock).toHaveBeenCalledWith(
      ACCOUNT_NOT_READY_TOAST_MESSAGE_START_CHAT,
      expect.objectContaining({
        action: expect.objectContaining({ label: 'Connect' }),
      }),
    );
  });
});

describe('accountGateRefetchInterval', () => {
  it('polls only while the gate reports blocked', () => {
    expect(accountGateRefetchInterval({ state: { data: { isAuthenticated: false } } })).toBe(
      10_000,
    );
    expect(accountGateRefetchInterval({ state: { data: { isAuthenticated: true } } })).toBe(false);
    expect(accountGateRefetchInterval({ state: { data: undefined } })).toBe(false);
  });
});
