// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DETECTION_QUERY_OPTIONS } from '../../../hooks/useConnectAccountFlow';
import { pendingAccountAuthAtom } from '../../../lib/atoms';
import { ConnectClaudeAccountPage } from '.';

type Detection =
  | { available: true; email?: string; displayName?: string; sourcePath?: string }
  | { available: false; hint?: string };

const detectMock = vi.fn();

const connect = vi.hoisted(() => ({ mutateAsync: vi.fn() }));

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      claudeCode: {
        listAccounts: { invalidate: vi.fn() },
        getResolvedAccount: { invalidate: vi.fn() },
      },
    }),
    claudeCode: {
      detectClaudeAccount: {
        useQuery: (_input: unknown, opts: unknown) => detectMock(opts),
      },
      connectClaudePassthrough: {
        useMutation: () => ({ mutateAsync: connect.mutateAsync }),
      },
    },
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const SOURCE_PATH = 'darwin-keychain://Claude%20Code-credentials';

const detectionState = (data: Detection | undefined) => ({
  data,
  isLoading: false,
  refetch: vi.fn(async () => ({ data })),
});

function renderPage(pending: { mode: 'add' | 'reauth' } = { mode: 'add' }) {
  const store = createStore();
  store.set(pendingAccountAuthAtom, { accountLabel: '', provider: 'claude-code', ...pending });
  const page = () => (
    <Provider store={store}>
      <ConnectClaudeAccountPage />
    </Provider>
  );
  const view = render(page());
  return { ...view, rerenderPage: () => view.rerender(page()) };
}

afterEach(() => {
  cleanup();
  detectMock.mockReset();
  connect.mutateAsync.mockReset();
});

describe('ConnectClaudeAccountPage', () => {
  it('passes the shared detection options so window-return refetch stops once a login is found', () => {
    detectMock.mockReturnValue(detectionState({ available: false }));

    renderPage();

    expect(detectMock).toHaveBeenCalledWith(DETECTION_QUERY_OPTIONS);
  });

  it('connects with the detected sourcePath and email, flagging reauth from the pending state', async () => {
    const user = userEvent.setup();
    detectMock.mockReturnValue(
      detectionState({ available: true, email: 'me@claude.example', sourcePath: SOURCE_PATH }),
    );
    connect.mutateAsync.mockResolvedValue(undefined);

    renderPage({ mode: 'reauth' });
    await user.click(screen.getByRole('button', { name: 'Reconnect' }));

    expect(connect.mutateAsync).toHaveBeenCalledWith({
      accountLabel: 'me@claude.example',
      sourcePath: SOURCE_PATH,
      expectedEmail: 'me@claude.example',
      reauth: true,
    });
  });

  it('treats a detection without a sourcePath as no login (no Connect CTA)', () => {
    detectMock.mockReturnValue(detectionState({ available: true, email: 'me@claude.example' }));

    const { container } = renderPage();

    expect(screen.getByText('No Claude login detected')).toBeInTheDocument();
    expect(container.querySelector('svg.text-warning')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
  });

  it('fails loud instead of posting an empty sourcePath when the login vanishes before Retry', async () => {
    const user = userEvent.setup();
    detectMock.mockReturnValue(
      detectionState({ available: true, email: 'me@claude.example', sourcePath: SOURCE_PATH }),
    );
    connect.mutateAsync.mockRejectedValueOnce(new Error('keychain locked'));

    const { rerenderPage } = renderPage();
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('keychain locked');

    // Signed out in Terminal while the Retry panel was up; detection now finds nothing.
    detectMock.mockReturnValue(detectionState({ available: false }));
    rerenderPage();
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No Claude Code login detected');
    expect(connect.mutateAsync).toHaveBeenCalledTimes(1);
  });
});
