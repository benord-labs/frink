// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateBanner } from './update-banner';

const installUpdate = vi.fn();
const dismissUpdate = vi.fn();
const downloadUpdate = vi.fn();

vi.mock('../lib/hooks/use-update-checker', () => ({
  useUpdateChecker: vi.fn(),
}));

vi.mock('../lib/hooks/use-just-updated', () => ({
  useJustUpdated: () => ({
    justUpdated: false,
    justUpdatedVersion: null,
    dismissJustUpdated: vi.fn(),
  }),
}));

import { useUpdateChecker } from '../lib/hooks/use-update-checker';

afterEach(cleanup);

describe('UpdateBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.desktopApi = {
      getVersion: vi.fn().mockResolvedValue('1.0.0'),
      isPackaged: vi.fn().mockResolvedValue(true),
      openExternal: vi.fn(),
    } as unknown as NonNullable<typeof window.desktopApi>;

    vi.mocked(useUpdateChecker).mockReturnValue({
      state: { status: 'idle' },
      checkForUpdates: vi.fn(),
      downloadUpdate,
      installUpdate,
      dismissUpdate,
    });
  });

  it('shows pending-restart copy and Restart now for silent patch downloads', async () => {
    const user = userEvent.setup();
    vi.mocked(useUpdateChecker).mockReturnValue({
      state: { status: 'pending-restart', version: '1.0.1' },
      checkForUpdates: vi.fn(),
      downloadUpdate,
      installUpdate,
      dismissUpdate,
    });

    render(<UpdateBanner />);

    expect(screen.getByText(/Update to v1\.0\.1 will apply when you quit/i)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /restart now/i }));
    expect(installUpdate).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /dismiss update notice/i }));
    expect(dismissUpdate).toHaveBeenCalledTimes(1);
  });
});
