import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../api', () => ({ requestNotifications: vi.fn() }));
vi.mock('./device', () => ({ permission: vi.fn(), pushToken: vi.fn() }));
import { requestNotifications, type Connection } from '../api';
import { permission, pushToken } from './device';
import { reconcileRegistration } from './registration';
const host = {
  url: 'https://host.ts.net',
  machineName: 'Mac',
  token: 'secret',
  deviceId: 'phone',
} as Connection;
const request = vi.mocked(requestNotifications);
const run = (desired?: boolean, signal = new AbortController().signal) =>
  reconcileRegistration(host, desired, signal);
beforeEach(() => {
  vi.resetAllMocks();
  request.mockResolvedValue({ enabled: false, error: null });
  vi.mocked(permission).mockResolvedValue(true);
  vi.mocked(pushToken).mockResolvedValue('ExpoPushToken[phone]');
});
it('only prompts and registers after explicit opt-in', async () => {
  vi.mocked(permission).mockResolvedValue(false);
  expect(await run()).toEqual({ enabled: false, denied: false, error: null });
  expect(permission).toHaveBeenCalledWith(false);
  expect(pushToken).not.toHaveBeenCalled();
  vi.mocked(permission).mockResolvedValue(true);
  expect(await run(true)).toEqual({ enabled: true, denied: false, error: null });
  expect(permission).toHaveBeenLastCalledWith(true);
  expect(request).toHaveBeenLastCalledWith(
    host,
    { token: 'ExpoPushToken[phone]' },
    expect.any(AbortSignal),
  );
});
it('says alerts are blocked only when they were wanted', async () => {
  vi.mocked(permission).mockResolvedValue(false);
  expect((await run(true)).denied).toBe(true);
  expect((await run(false)).denied).toBe(false);
});
it.each([false, true])(
  'removes a registration when turned off or blocked in iPhone Settings (turned off: %s)',
  async (turnedOff) => {
    request.mockResolvedValue({ enabled: true, error: null });
    vi.mocked(permission).mockResolvedValue(turnedOff);
    const state = await run(turnedOff ? false : undefined);
    expect(state.enabled).toBe(false);
    expect(request).toHaveBeenLastCalledWith(host, { token: null }, expect.any(AbortSignal));
  },
);
it('refreshes a rotated token without a permission prompt', async () => {
  request.mockResolvedValue({ enabled: true, error: null });
  await run();
  expect(permission).toHaveBeenCalledWith(false);
  expect(pushToken).toHaveBeenCalledOnce();
});
it('shows a delivery failure on refresh, and clears it on a tap', async () => {
  request.mockResolvedValue({ enabled: false, error: 'Your Mac couldn’t deliver the last alert.' });
  expect((await run()).error).toContain('couldn’t deliver');
  expect((await run(true)).error).toBeNull();
});
it('does not register after the screen goes away mid-setup', async () => {
  const controller = new AbortController();
  vi.mocked(pushToken).mockImplementation(async () => {
    controller.abort();
    return 'ExpoPushToken[late]';
  });
  await expect(run(true, controller.signal)).rejects.toThrow();
  expect(request).toHaveBeenCalledOnce();
});
