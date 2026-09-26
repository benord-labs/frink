// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellOpenExternalResult } from '../../../shared/shell-external-url';
import { type ConnectChecklistRow, type ConnectLinkState, TransientConnectDialog } from './index';

const CONNECT_LINK = 'https://connect.frink.dev/?session_token=abc';

const provider = { id: 'linear', display_name: 'Linear' };

type Overrides = {
  connectingProvider?: string;
  connectError?: string;
  checklist?: readonly ConnectChecklistRow[];
  provider?: { id: string; display_name: string };
  onRetry?: (providerId: string) => void;
};

function renderDialog(connectLink: ConnectLinkState | null, overrides: Overrides = {}) {
  return render(
    <TransientConnectDialog
      connectingProvider={overrides.connectingProvider ?? 'linear'}
      connectError={overrides.connectError ?? null}
      connectLink={connectLink}
      checklist={overrides.checklist ?? []}
      provider={overrides.provider ?? provider}
      onClose={vi.fn()}
      onRetry={overrides.onRetry ?? vi.fn()}
    />,
  );
}

const openExternalMock = vi.fn<(url: string) => Promise<ShellOpenExternalResult>>();

describe('TransientConnectDialog', () => {
  beforeEach(() => {
    openExternalMock.mockReset().mockResolvedValue({ success: true });
    vi.stubGlobal('desktopApi', { openExternal: openExternalMock });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('tells the user the browser did not open and offers the link instead', () => {
    renderDialog({ url: CONNECT_LINK, browserLaunchFailed: true });

    expect(screen.getByRole('alert')).toHaveTextContent(
      "Frink couldn't open your browser. Copy the link below to finish signing in.",
    );
    // "A tab should have opened" would be a lie here: none was.
    expect(screen.queryByText(/a browser tab should have opened/i)).not.toBeInTheDocument();
    expect(screen.getByText(/paste it into your browser/i)).toBeInTheDocument();
  });

  it('keeps the waiting copy while the browser is believed to have opened', () => {
    renderDialog({ url: CONNECT_LINK, browserLaunchFailed: false });

    expect(screen.getByText(/a browser tab should have opened/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Preparing your sign-in…')).not.toBeInTheDocument();
    expect(screen.getByText(/copy this link into your browser/i)).toBeInTheDocument();
  });

  it('does not offer to reopen a browser that just refused to open', () => {
    renderDialog({ url: CONNECT_LINK, browserLaunchFailed: true });

    expect(screen.queryByRole('button', { name: /open the sign-in page again/i })).toBeNull();
  });

  it('offers to reopen the page while the browser is believed to work', () => {
    renderDialog({ url: CONNECT_LINK, browserLaunchFailed: false });

    expect(
      screen.getByRole('button', { name: /open the sign-in page again/i }),
    ).toBeInTheDocument();
  });

  it('serves a catalog plugin whose consent runs in the system browser: named, cancellable, retried by id', () => {
    const onRetry = vi.fn();
    const notion = { id: 'notion', display_name: 'Notion' };
    const { unmount } = renderDialog(
      { url: CONNECT_LINK, browserLaunchFailed: false },
      { connectingProvider: 'notion', provider: notion },
    );
    expect(screen.getByRole('heading', { name: 'Connecting Notion...' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByText(/copy this link into your browser/i)).toBeInTheDocument();
    unmount();

    renderDialog(null, {
      connectingProvider: 'notion',
      connectError: 'Authorization cancelled.',
      provider: notion,
      onRetry,
    });
    expect(screen.getByRole('heading', { name: 'Connection Failed' })).toBeInTheDocument();
    screen.getByRole('button', { name: 'Try Again' }).click();
    expect(onRetry).toHaveBeenCalledWith('notion');
  });

  it('offers every provider the same retry after a failed connect', () => {
    renderDialog(null, { connectError: 'Failed to create session' });

    expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
    // Said once, and that one place is the live region, so the state change is announced.
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent('Failed to create session');
  });

  it('shows preparation until a sign-in link exists', () => {
    renderDialog(null, { checklist: [{ done: false }] });

    expect(screen.getByText('Preparing your sign-in…')).toBeInTheDocument();
    expect(screen.getByText('Preparing…')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Your browser will open when the connection is ready.',
    );
    expect(screen.queryByText(/a browser tab should have opened/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Waiting for you in the browser…')).not.toBeInTheDocument();
    expect(screen.queryByText(/copy this link/i)).not.toBeInTheDocument();
  });

  describe('the grant checklist', () => {
    it('names the vendor sign-in while the browser leg runs', () => {
      renderDialog(
        { url: CONNECT_LINK, browserLaunchFailed: false },
        { checklist: [{ done: false }] },
      );

      const rows = within(screen.getByRole('list', { name: 'Sign-in steps' })).getAllByRole(
        'listitem',
      );
      expect(rows.map((row) => row.textContent)).toEqual([
        'Sign in to LinearWaiting for you in the browser…',
      ]);
      expect(screen.queryByText('All set. You can close the browser tab.')).not.toBeInTheDocument();
    });

    it('keeps the row in the failed state, marking what never landed Cancelled', () => {
      renderDialog(null, {
        connectError: 'Sign-in cancelled.',
        checklist: [{ done: false }],
      });

      const rows = within(screen.getByRole('list', { name: 'Sign-in steps' })).getAllByRole(
        'listitem',
      );
      expect(rows.map((row) => row.textContent)).toEqual(['Sign in to LinearCancelled']);
      expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
    });

    it('shows finishing setup after sign-in while the connection operation is still pending', () => {
      renderDialog(
        { url: CONNECT_LINK, browserLaunchFailed: false },
        { checklist: [{ done: true }] },
      );

      expect(screen.getAllByText('Done')).toHaveLength(1);
      expect(screen.getByRole('heading', { name: 'Finishing setup' })).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Setting up your connection…');
      expect(
        screen.getByText("You're signed in to Linear. You can close the browser tab."),
      ).toBeInTheDocument();
      expect(screen.queryByText(/All set/)).not.toBeInTheDocument();
      expect(screen.queryByText(/a browser tab should have opened/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /open the sign-in page again/i })).toBeNull();
      expect(screen.queryByText(/copy this link into your browser/i)).not.toBeInTheDocument();
    });

    it('shows one vendor sign-in for an official plugin with only an MCP grant', () => {
      renderDialog(
        { url: CONNECT_LINK, browserLaunchFailed: false },
        {
          connectingProvider: 'clickup',
          provider: { id: 'clickup', display_name: 'ClickUp' },
          checklist: [{ done: false }],
        },
      );
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText('Sign in to ClickUp')).toBeInTheDocument();
      expect(within(dialog).getAllByRole('listitem')).toHaveLength(1);
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });

    it('renders no list until the chain knows the grants', () => {
      renderDialog(null);

      expect(screen.queryByRole('list', { name: 'Sign-in steps' })).not.toBeInTheDocument();
    });
  });
});
