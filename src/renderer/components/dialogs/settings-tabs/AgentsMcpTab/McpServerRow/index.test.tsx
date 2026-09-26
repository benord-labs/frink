// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { McpServerRow } from './index';

// oxlint-disable-next-line anti-slop/no-module-mocking -- the plugins barrel (for the plugin's mark) pulls in the tRPC client, which needs Electron's preload
vi.mock('@/lib/trpc', () => ({ trpc: {} }));

const noop = vi.fn();

const baseProps = {
  name: 'PostHog',
  status: 'connected',
  tools: ['insights'],
  needsSetup: false,
  isExpanded: false,
  isEnabled: true,
  onToggle: noop,
  onConfigure: noop,
  onReconnect: noop,
  onToggleEnabled: noop,
  onDelete: noop,
};

const POSTHOG = { id: 'posthog', name: 'PostHog', title: 'PostHog' };

/** Every control a user's own server offers; a plugin's server must offer none of them. */
const USER_SERVER_ACTIONS = ['Configure', 'Reconnect', 'Turn off', 'Remove'];

const menuItemLabels = () => screen.getAllByRole('menuitem').map((item) => item.textContent);

describe('McpServerRow', () => {
  it("hands a plugin's server back to the Plugins page and offers nothing else", () => {
    const onOpenPluginPage = vi.fn();
    render(
      <McpServerRow
        {...baseProps}
        isExpanded
        plugin={POSTHOG}
        onOpenPluginPage={onOpenPluginPage}
      />,
    );

    expect(screen.getByText('Set up by the PostHog plugin')).not.toBeNull();
    expect(screen.getByText('PostHog manages this server.')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'More actions for PostHog' })).toBeNull();
    for (const action of USER_SERVER_ACTIONS) {
      expect(screen.queryByRole('button', { name: action })).toBeNull();
    }

    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    expect(onOpenPluginPage).toHaveBeenCalledTimes(1);
  });

  it('gives a server the user added its full menu and labelled actions', () => {
    render(<McpServerRow {...baseProps} name="my-server" isExpanded />);

    for (const action of USER_SERVER_ACTIONS) {
      expect(screen.getByRole('button', { name: action })).not.toBeNull();
    }
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions for my-server' }));
    expect(menuItemLabels()).toEqual(USER_SERVER_ACTIONS);
  });

  it('shows a plugin row that still needs authorising without offering Set up', () => {
    render(
      <McpServerRow
        {...baseProps}
        status="needs_auth"
        tools={[]}
        needsSetup
        isExpanded
        plugin={POSTHOG}
        onOpenPluginPage={noop}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Set up' })).toBeNull();
    expect(screen.getByText('Needs setup')).not.toBeNull();
  });

  it('offers Set up on an open user server that still needs authorising', () => {
    const onConfigure = vi.fn();
    render(
      <McpServerRow
        {...baseProps}
        name="my-server"
        status="needs_auth"
        tools={[]}
        needsSetup
        isExpanded
        onConfigure={onConfigure}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Set up' }));
    expect(onConfigure).toHaveBeenCalledTimes(1);
  });

  it('puts the reason for an error on the second line, in red', () => {
    render(
      <McpServerRow
        {...baseProps}
        name="sentry"
        status="error"
        tools={[]}
        statusDetail="Could not reach the server."
      />,
    );

    expect(screen.getByText('Could not reach the server.').className).toContain('text-destructive');
  });

  it('keeps line two for a description, leaving the address to the open row', () => {
    render(
      <McpServerRow
        {...baseProps}
        name="figma"
        tools={[]}
        url="https://mcp.figma.com/mcp"
        isExpanded
      />,
    );

    expect(screen.getByText('No description')).not.toBeNull();
    expect(screen.getByText('https://mcp.figma.com/mcp')).not.toBeNull();
  });
});
