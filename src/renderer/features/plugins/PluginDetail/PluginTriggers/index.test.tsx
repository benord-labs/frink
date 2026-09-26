// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginConnection, ResolvedPlugin } from '../../../../../shared/integrations/plugins';
import { resolvePlugins } from '../../../../../shared/integrations/plugins';
import { PluginTriggers } from './index';

// The card has its own suite; the double shows its props and reads initialSetupOpen once at mount.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('./TriggerCard', async () => {
  const { useState } = await import('react');
  return {
    TriggerCard: ({
      integrationId,
      provider,
      enabled,
      initialSetupOpen,
    }: {
      integrationId: string;
      provider: string;
      enabled: boolean;
      initialSetupOpen?: boolean;
    }) => {
      const [openedAtMount] = useState(initialSetupOpen === true);
      return (
        <div data-testid="trigger-card" data-setup-open={String(openedAtMount)}>
          {provider}:{integrationId}:{enabled ? 'on' : 'off'}
        </div>
      );
    },
  };
});

function pluginWith(pluginId: string, items: PluginConnection[]): ResolvedPlugin {
  const plugin = resolvePlugins({ installations: [], connections: items }).find(
    (candidate) => candidate.definition.id === pluginId,
  );
  if (!plugin) throw new Error(`${pluginId} is not in the catalogue`);
  return plugin;
}

afterEach(cleanup);

describe('PluginTriggers', () => {
  it('renders the trigger card for a pasted plugin, bound to its live account', () => {
    render(
      <PluginTriggers
        plugin={pluginWith('shortcut', [{ id: 'c1', providerId: 'shortcut', isActive: true }])}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Triggers' })).toBeInTheDocument();
    expect(screen.getByTestId('trigger-card')).toHaveTextContent('shortcut:c1:on');
    expect(screen.getByText('Frink must be open for triggers to run.')).toBeInTheDocument();
  });

  it('renders one card per live account, each labelled by its account', () => {
    render(
      <PluginTriggers
        plugin={pluginWith('shortcut', [
          { id: 'c1', providerId: 'shortcut', accountIdentifier: 'acme', isActive: true },
          { id: 'c2', providerId: 'shortcut', accountIdentifier: 'beta', isActive: true },
          { id: 'c3', providerId: 'shortcut', accountIdentifier: 'gone', isActive: false },
        ])}
      />,
    );

    expect(screen.getAllByTestId('trigger-card').map((node) => node.textContent)).toEqual([
      'shortcut:c1:on',
      'shortcut:c2:on',
    ]);
    expect(screen.getByText('acme')).toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();
    expect(screen.queryByText('gone')).not.toBeInTheDocument();
  });

  it('gives a plugin Frink registers itself the same card as one the user pastes', () => {
    render(
      <PluginTriggers
        plugin={pluginWith('linear', [{ id: 'l1', providerId: 'linear', isActive: true }])}
      />,
    );

    expect(screen.getByTestId('trigger-card')).toHaveTextContent('linear:l1:on');
  });

  it('renders nothing without a live account', () => {
    const { container } = render(
      <PluginTriggers
        plugin={pluginWith('shortcut', [{ id: 'c1', providerId: 'shortcut', isActive: false }])}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('offers to set the trigger up for a plugin with no account of its own, then shows its card', () => {
    const create = vi.fn(async () => {});
    const { rerender } = render(
      <PluginTriggers
        plugin={pluginWith('posthog', [])}
        endpointSetup={{ offered: true, isPending: false, create }}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Triggers' })).toBeInTheDocument();
    expect(screen.getByText(/Let PostHog tell Frink when something happens/)).toBeInTheDocument();
    expect(screen.queryByTestId('trigger-card')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Set up automatically' }));
    expect(create).toHaveBeenCalledOnce();

    rerender(
      <PluginTriggers
        plugin={pluginWith('posthog', [{ id: 'p1', providerId: 'posthog', isActive: true }])}
        endpointSetup={{ offered: false, isPending: false, create }}
      />,
    );
    expect(screen.getByTestId('trigger-card')).toHaveTextContent('posthog:p1:on');
    expect(screen.queryByRole('button', { name: 'Set up automatically' })).toBeNull();
  });

  it('renders nothing for a plugin with no account while the offer is withheld', () => {
    const { container } = render(
      <PluginTriggers
        plugin={pluginWith('posthog', [])}
        endpointSetup={{ offered: false, isPending: false, create: async () => {} }}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a plugin with no trigger-capable provider row', () => {
    const { container } = render(
      <PluginTriggers
        plugin={pluginWith('neon', [{ id: 'n1', providerId: 'neon', isActive: true }])}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
  it('carries the manual setup click into the newly created account card', () => {
    const create = vi.fn(async () => {});
    const { rerender } = render(
      <PluginTriggers
        plugin={pluginWith('notion', [])}
        endpointSetup={{ offered: true, isPending: false, create }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Set up events' }));
    rerender(
      <PluginTriggers
        plugin={pluginWith('notion', [{ id: 'n1', providerId: 'notion', isActive: true }])}
        endpointSetup={{ offered: false, isPending: false, create }}
      />,
    );
    expect(create).toHaveBeenCalledOnce();
    expect(screen.getByTestId('trigger-card')).toHaveAttribute('data-setup-open', 'true');

    rerender(
      <PluginTriggers
        plugin={pluginWith('notion', [
          { id: 'n1', providerId: 'notion', isActive: true },
          { id: 'n2', providerId: 'notion', isActive: true },
        ])}
        endpointSetup={{ offered: false, isPending: false, create }}
      />,
    );
    const cards = screen.getAllByTestId('trigger-card');
    expect(cards[1]).toHaveAttribute('data-setup-open', 'false');
  });
});
