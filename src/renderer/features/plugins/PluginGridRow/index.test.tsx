// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PluginConnection,
  PluginInstallationSnapshot,
} from '../../../../shared/integrations/plugins';
import { resolvePlugins } from '../../../../shared/integrations/plugins';
import type { PluginToolsState } from '../../../lib/plugins/plugin-view-model';
import { PluginGridRow } from './index';

const onOpen = vi.fn();

function renderRow(
  pluginId: string,
  options: {
    connections?: PluginConnection[];
    installations?: PluginInstallationSnapshot[];
    tools?: PluginToolsState;
  } = {},
) {
  const plugin = resolvePlugins({
    installations: options.installations ?? [],
    connections: options.connections ?? [],
  }).find((candidate) => candidate.definition.id === pluginId);
  if (!plugin) throw new Error(`${pluginId} missing from the catalog`);
  return render(
    <ul>
      <PluginGridRow plugin={plugin} tools={options.tools} onOpen={onOpen} />
    </ul>,
  );
}

const SHORTCUT = [{ id: 'c1', providerId: 'shortcut', isActive: true }];
// ClickUp declares both grants: a webhook account and the vendor MCP's own consent.
const INSTALLED_CLICKUP: PluginInstallationSnapshot = {
  id: 'install-clickup',
  pluginId: 'clickup',
  sourceKind: 'frink_builtin',
  sourceLocator: null,
  installedVersion: null,
  isInstalled: true,
  isEnabled: true,
};

beforeEach(() => {
  onOpen.mockReset();
});

afterEach(cleanup);

describe('PluginGridRow', () => {
  it('opens the plugin for inspection', () => {
    renderRow('shortcut');

    fireEvent.click(screen.getByRole('button', { name: /Shortcut/ }));
    expect(onOpen).toHaveBeenCalledWith('shortcut');
  });

  it('offers no connect control of its own, whatever the plugin is doing', () => {
    // Connecting is a decision made on the plugin's own page, after reading what
    // it installs. A row that could authorize an account short-circuits that.
    for (const options of [{}, { connections: SHORTCUT }, { state: 'error' as const }]) {
      renderRow('shortcut', options);
      expect(screen.getAllByRole('button')).toHaveLength(1);
      cleanup();
    }
  });

  it('says what the plugin does, connected or not', () => {
    // The question a directory answers. Which account is connected is a
    // detail-page concern, and naming it here cost the row its only description.
    const { description } = resolvePlugins({ installations: [] }).find(
      (candidate) => candidate.definition.id === 'shortcut',
    )!.definition;

    renderRow('shortcut', { connections: SHORTCUT });
    expect(screen.getByText(description)).toBeInTheDocument();
  });

  it('leaves a healthy row unmarked, announcing what its section heading shows', () => {
    // A visible mark means something needs attention. "Connected" is already the
    // heading this row sits under, so only the screen reader is told again.
    renderRow('shortcut', { connections: SHORTCUT });

    expect(screen.queryByTestId('plugin-row-status')).not.toBeInTheDocument();
    expect(screen.getByText('Connected')).toHaveClass('sr-only');
  });

  it('never announces Connected while a declared grant is still missing', () => {
    // A live account whose tools grant is still awaiting consent: the row must
    // not claim a state its own page would deny.
    renderRow('clickup', {
      installations: [INSTALLED_CLICKUP],
      connections: [{ id: 'c1', providerId: 'clickup', isActive: true }],
      tools: 'awaiting',
    });
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });

  it('announces a tools-only plugin Connected on its tools grant alone', () => {
    renderRow('notion', { tools: 'connected' });

    expect(screen.getByText('Connected')).toHaveClass('sr-only');
  });

  it('disables navigation for coming-soon plugins while keeping their status readable', () => {
    renderRow('docusign');

    expect(screen.queryByTestId('plugin-row-status')).not.toBeInTheDocument();
    expect(screen.getByText('Coming soon')).toHaveClass('sr-only');
    const button = screen.getByRole('button', { name: /Docusign/ });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('keeps an unshipped row coming soon and non-clickable even with a saved account', () => {
    renderRow('docusign', {
      connections: [{ id: 'c1', providerId: 'docusign', isActive: true }],
    });

    expect(screen.getByText('Coming soon')).toBeInTheDocument();
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('marks a turned-off plugin, which its Connected heading cannot show', () => {
    renderRow('shortcut', {
      connections: SHORTCUT,
      installations: [{ ...INSTALLED_CLICKUP, pluginId: 'shortcut', isEnabled: false }],
    });

    expect(screen.getByTestId('plugin-row-status')).toHaveTextContent('Turned off');
  });
});
