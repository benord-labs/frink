// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileSettingsTab } from './index';

const mutation = { mutate: vi.fn(), isPending: false };

// oxlint-disable-next-line anti-slop/no-module-mocking -- the tRPC client needs Electron's preload; the tab reads mobile access status
vi.mock('@/lib/trpc', () => ({
  trpc: {
    mobile: {
      status: {
        useQuery: () => ({
          isLoading: false,
          data: { enabled: false, running: false, relayConnected: false, devices: [] },
        }),
      },
      enable: { useMutation: () => mutation },
      disable: { useMutation: () => mutation },
      revoke: { useMutation: () => mutation },
      pair: { useMutation: () => mutation },
    },
  },
}));

afterEach(cleanup);

describe('MobileSettingsTab', () => {
  it('offers the iPhone app download before mobile access is turned on', () => {
    render(<MobileSettingsTab />);

    expect(screen.getByText('Get the iPhone app')).toBeInTheDocument();
    expect(screen.getByText(/open frink\.dev\/ios on your phone/)).toBeInTheDocument();
    const qr = screen.getByTitle('Scan to get Frink for iPhone').closest('svg');
    expect(qr).toBeInTheDocument();
    expect(screen.queryByText('Pair your iPhone')).not.toBeInTheDocument();
  });
});
