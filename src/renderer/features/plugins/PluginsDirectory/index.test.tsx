// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginConnection } from '../../../../shared/integrations/plugins';
import { PLUGIN_DEFINITIONS, resolvePlugins } from '../../../../shared/integrations/plugins';
import { PluginsDirectory } from './index';

type McpEntry = { serverName: string; pluginName: string };
/** The slice of the status query the directory reads. */
type McpStatusQuery = {
  data?: { connected: McpEntry[]; awaitingAuth: McpEntry[] };
  isError?: boolean;
};

const { pluginsListUseQueryMock, vendorMcpStatusUseQueryMock } = vi.hoisted(() => ({
  pluginsListUseQueryMock: vi.fn(),
  vendorMcpStatusUseQueryMock: vi.fn((): McpStatusQuery => ({})),
}));

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    plugins: {
      list: { useQuery: pluginsListUseQueryMock },
      vendorMcpStatus: { useQuery: vendorMcpStatusUseQueryMock },
      uninstall: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      setEnabled: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    useUtils: () => ({
      plugins: { list: { invalidate: vi.fn() } },
      integrations: { invalidate: vi.fn() },
    }),
  },
}));

function mockCatalog(connections: ReadonlyArray<PluginConnection> = []) {
  pluginsListUseQueryMock.mockReturnValue({
    isLoading: false,
    isError: false,
    data: { plugins: resolvePlugins({ installations: [], connections }) },
  });
}

const onOpen = vi.fn();

function renderDirectory() {
  return render(<PluginsDirectory onOpen={onOpen} />);
}

beforeEach(() => {
  pluginsListUseQueryMock.mockReset();
  vendorMcpStatusUseQueryMock.mockReset();
  vendorMcpStatusUseQueryMock.mockReturnValue({});
  onOpen.mockReset();
  mockCatalog();
});

afterEach(cleanup);

/** Row assertions scope to the catalog rather than its capability overview. */
function rows() {
  return within(screen.getByTestId('plugins-list'));
}

describe('PluginsDirectory', () => {
  it('lists every builtin plugin under a section', () => {
    renderDirectory();

    expect(rows().getByText('Shortcut')).toBeInTheDocument();
    expect(rows().getByText('Linear')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Available' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Coming soon' })).toBeInTheDocument();
  });

  it('folds Coming soon behind its count, since nothing there can be acted on', () => {
    renderDirectory();

    const heading = screen.getByRole('button', { name: /^Coming soon \d+$/ });
    expect(heading).toHaveAttribute('aria-expanded', 'false');
    expect(rows().queryByText('Docusign')).not.toBeInTheDocument();

    fireEvent.click(heading);
    expect(rows().getByText('Docusign')).toBeInTheDocument();

    // A search unfolds it: a match the user typed for must never hide behind a disclosure.
    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'esignature' } });
    expect(screen.getByRole('region', { name: 'Coming soon' })).toBeInTheDocument();
    const result = screen.getByRole('button', { name: /Docusign/ });
    expect(result).toBeDisabled();
    fireEvent.click(result);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('files a tools-only plugin under Connected on its tools grant alone', () => {
    vendorMcpStatusUseQueryMock.mockReturnValue({
      data: {
        connected: [{ serverName: 'plugin_notion_notion', pluginName: 'notion' }],
        awaitingAuth: [],
      },
    });
    renderDirectory();
    const connected = screen.getByRole('region', { name: 'Connected' });
    expect(within(connected).getByText('Notion')).toBeInTheDocument();
  });

  it('shows no Connected section until an account is live', () => {
    renderDirectory();
    expect(screen.queryByRole('region', { name: 'Connected' })).not.toBeInTheDocument();

    cleanup();
    mockCatalog([{ id: 'c1', providerId: 'shortcut', isActive: true }]);
    renderDirectory();
    expect(screen.getByRole('region', { name: 'Connected' })).toBeInTheDocument();
  });

  it('filters rows by search across names and triggers', () => {
    renderDirectory();

    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'notion' } });
    expect(rows().getByText('Notion')).toBeInTheDocument();
    expect(rows().queryByText('Shortcut')).not.toBeInTheDocument();
  });

  it('tells the user when a search matches nothing', () => {
    renderDirectory();

    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'zzzz' } });
    expect(screen.getByText(/No plugins match/)).toBeInTheDocument();
  });

  it('narrows to a group when its filter is selected', () => {
    renderDirectory();

    fireEvent.click(screen.getByRole('tab', { name: 'Available' }));
    expect(rows().getByText('Shortcut')).toBeInTheDocument();
    expect(rows().queryByText('Docusign')).not.toBeInTheDocument();
  });

  it('offers no Coming soon filter, since nothing there can be acted on', () => {
    renderDirectory();

    expect(screen.queryByRole('tab', { name: /Coming soon/ })).not.toBeInTheDocument();
    // The section itself stays: those plugins are still listed.
    expect(screen.getByRole('region', { name: 'Coming soon' })).toBeInTheDocument();
  });

  it('keeps the count out of a filter tab accessible name', () => {
    renderDirectory();

    const all = screen.getByRole('tab', { name: 'All' });
    expect(all).toBeInTheDocument();
    // One per catalog entry, providers and data-folder plugins alike.
    expect(all).toHaveTextContent(String(PLUGIN_DEFINITIONS.length));
  });

  it('marks the active filter for assistive tech', () => {
    renderDirectory();
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens a plugin for inspection without connecting it', () => {
    renderDirectory();

    fireEvent.click(screen.getByRole('button', { name: /^Shortcut/ }));
    expect(onOpen).toHaveBeenCalledWith('shortcut');
  });

  it('shows a placeholder while loading', () => {
    pluginsListUseQueryMock.mockReturnValue({ isLoading: true, isError: false, data: undefined });
    renderDirectory();
    expect(screen.getByLabelText('Loading plugins')).toBeInTheDocument();
  });

  it('says so when the catalog cannot be read', () => {
    pluginsListUseQueryMock.mockReturnValue({ isLoading: false, isError: true, data: undefined });
    renderDirectory();
    expect(screen.getByText('Plugins are unavailable right now.')).toBeInTheDocument();
  });
});
