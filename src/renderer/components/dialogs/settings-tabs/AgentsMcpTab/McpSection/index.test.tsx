// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { McpSection } from './index';

const capturedNames: string[] = [];
const capturedPluginRows: string[] = [];
const toggles = new Map<string, () => void>();

vi.mock('../McpServerRow', () => ({
  McpServerRow: ({
    name,
    onOpenPluginPage,
    onToggleEnabled,
  }: {
    name: string;
    onOpenPluginPage?: () => void;
    onToggleEnabled: () => void;
  }) => {
    capturedNames.push(name);
    toggles.set(name, onToggleEnabled);
    if (onOpenPluginPage) capturedPluginRows.push(name);
    return (
      <li>
        <button type="button">{name}</button>
      </li>
    );
  },
}));

const noop = vi.fn();

const makeMcp = (name: string, extra: { status?: string; config?: object } = {}) => ({
  name,
  config: {},
  status: 'ready',
  ...extra,
});

const defaultProps = {
  query: '',
  expandedServer: null,
  reconnectingServer: null,
  onToggleExpanded: noop,
  onConfigure: noop,
  onReconnect: noop,
  onToggleEnabled: noop,
  onDelete: noop,
  onOpenPluginPage: noop,
};

describe('McpSection', () => {
  it('renders servers in alphabetical order', () => {
    capturedNames.length = 0;

    render(
      <McpSection
        {...defaultProps}
        mcps={[makeMcp('zebra'), makeMcp('alpha'), makeMcp('mango')]}
      />,
    );

    expect(capturedNames).toEqual(['alpha', 'mango', 'zebra']);
  });

  it('handles case-insensitive sorting', () => {
    capturedNames.length = 0;

    render(
      <McpSection
        {...defaultProps}
        mcps={[makeMcp('Zebra'), makeMcp('alpha'), makeMcp('Mango')]}
      />,
    );

    expect(capturedNames).toEqual(['alpha', 'Mango', 'Zebra']);
  });

  it('puts broken servers first, whoever owns them, and folds turned-off and plugin servers', () => {
    capturedNames.length = 0;
    capturedPluginRows.length = 0;
    const onOpenPluginPage = vi.fn();
    const plugin = { managedBy: 'vendor_plugin' };

    render(
      <McpSection
        {...defaultProps}
        onOpenPluginPage={onOpenPluginPage}
        mcps={[
          makeMcp('alpha'),
          makeMcp('zebra', { status: 'error' }),
          makeMcp('plugin_posthog_posthog', { status: 'needs_auth', config: plugin }),
          makeMcp('plugin_shortcut_shortcut', { config: plugin }),
          makeMcp('old', { status: 'error', config: { enabled: false } }),
        ]}
      />,
    );

    expect(capturedNames).toEqual(['PostHog', 'zebra', 'alpha']);
    expect(screen.getByRole('button', { name: 'Turned off 1' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    fireEvent.click(screen.getByRole('button', { name: 'From plugins 1' }));
    expect(capturedPluginRows).toEqual(['PostHog', 'Shortcut']);

    fireEvent.click(screen.getByRole('button', { name: 'Manage in Directory' }));
    expect(onOpenPluginPage).toHaveBeenCalledTimes(1);
  });

  it('opens every group with a match while searching', () => {
    capturedNames.length = 0;

    render(
      <McpSection
        {...defaultProps}
        query="post"
        mcps={[
          makeMcp('alpha'),
          makeMcp('plugin_posthog_posthog', { config: { managedBy: 'vendor_plugin' } }),
        ]}
      />,
    );

    expect(capturedNames).toEqual(['PostHog']);
  });

  it('keeps a lone turned-off group folded', () => {
    render(
      <McpSection {...defaultProps} mcps={[makeMcp('old', { config: { enabled: false } })]} />,
    );

    expect(screen.getByRole('button', { name: 'Turned off 1' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('opens the folded group a server moves into after an action from its menu', () => {
    const mcps = [makeMcp('alpha'), makeMcp('old', { config: { enabled: false } })];
    const { rerender } = render(<McpSection {...defaultProps} mcps={mcps} />);

    act(() => toggles.get('alpha')?.());
    rerender(
      <McpSection
        {...defaultProps}
        mcps={[makeMcp('alpha', { config: { enabled: false } }), mcps[1]]}
      />,
    );

    expect(screen.getByRole('button', { name: 'Turned off 2' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('button', { name: 'alpha' })).toHaveFocus();
  });

  it('says so when the search matches nothing', () => {
    render(<McpSection {...defaultProps} query="nope" mcps={[makeMcp('alpha')]} />);

    expect(screen.getByText('No servers match “nope”.')).toBeInTheDocument();
  });

  it('renders nothing when there are no servers', () => {
    const { container } = render(<McpSection {...defaultProps} mcps={[]} />);

    expect(container.innerHTML).toBe('');
  });
});
