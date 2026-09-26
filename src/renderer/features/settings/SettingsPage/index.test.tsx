// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './index';

type ProjectRowFixture = {
  id: string;
  name: string;
  gitRepo: string | null;
  gitRemoteUrl: string | null;
  path: string;
};
type ProjectsQueryFixture = {
  data: ProjectRowFixture[] | undefined;
  isLoading: boolean;
  isFetchedAfterMount?: boolean;
  isFetching?: boolean;
};

const testState = vi.hoisted(() => {
  const projects: ProjectsQueryFixture = { data: [], isLoading: false };
  return { activeTab: 'preferences', setActiveTab: vi.fn(), projects };
});

vi.mock('jotai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jotai')>();
  return {
    ...actual,
    useAtom: () => [testState.activeTab, testState.setActiveTab],
    useAtomValue: () => false,
  };
});

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    projects: {
      list: { useQuery: () => testState.projects },
    },
    // A chat folder's page only renders the AI account section.
    claudeCode: {
      listAccounts: { useQuery: () => ({ data: [] }) },
      getProjectAccount: { useQuery: () => ({ data: null, refetch: vi.fn() }) },
      setProjectAccount: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    useUtils: () => ({ claudeCode: { getResolvedAccount: { invalidate: vi.fn() } } }),
  },
}));

vi.mock('../../../components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('../../../components/ui/kbd', () => ({
  Kbd: () => <span data-testid="kbd" />,
}));

vi.mock('../../../components/dialogs/settings-tabs/AgentsCustomAgentsTab', () => ({
  AgentsCustomAgentsTab: () => <div data-testid="tab-custom-agents" />,
}));
vi.mock('../../../components/dialogs/settings-tabs/AgentsHooksTab', () => ({
  AgentsHooksTab: () => <div data-testid="tab-hooks" />,
}));
vi.mock('../../../components/dialogs/settings-tabs/AgentsMcpTab', () => ({
  AgentsMcpTab: () => <div data-testid="tab-mcp" />,
}));
vi.mock('../../../components/dialogs/settings-tabs/AgentsModelsTab', () => ({
  AgentsModelsTab: () => <div data-testid="tab-models" />,
}));
vi.mock('../../../components/dialogs/settings-tabs/AgentsPermissionsTab', () => ({
  AgentsPermissionsTab: () => <div data-testid="tab-permissions" />,
}));
vi.mock('../../../components/dialogs/settings-tabs/AgentsSkillsTab', () => ({
  AgentsSkillsTab: () => <div data-testid="tab-skills" />,
}));
vi.mock('../../../components/dialogs/settings-tabs/agents-appearance-tab', () => ({
  AgentsAppearanceTab: () => <div data-testid="tab-appearance" />,
}));
vi.mock('../../../components/dialogs/settings-tabs/agents-debug-tab', () => ({
  AgentsDebugTab: () => <div data-testid="tab-debug" />,
}));
vi.mock('../../../components/dialogs/settings-tabs/agents-keyboard-tab', () => ({
  AgentsKeyboardTab: () => <div data-testid="tab-keyboard" />,
}));
vi.mock('../../../components/dialogs/settings-tabs/agents-preferences-tab', () => ({
  AgentsPreferencesTab: () => <div data-testid="tab-preferences" />,
}));

describe('SettingsPage', () => {
  beforeEach(() => {
    cleanup();
    testState.activeTab = 'preferences';
    testState.projects = { data: [], isLoading: false };
    testState.setActiveTab.mockClear();
  });

  it('renders the regrouped settings navigation in the intended order', () => {
    const { container } = render(<SettingsPage onClose={vi.fn()} />);

    const navigation = screen.getByRole('navigation', { name: 'Settings navigation' });
    const navigationText = navigation.textContent ?? '';
    const groupLabels = ['General', 'Agent setup', 'Security', 'Projects', 'Advanced'];
    let previousIndex = -1;

    for (const label of groupLabels) {
      const index = navigationText.indexOf(label);
      expect(index).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }

    expect(screen.getByRole('button', { name: 'Preferences' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const atmosphere = container.querySelector('.chat-canvas-atmosphere');
    const atmosphereSurface = atmosphere?.parentElement;
    const mainPane = atmosphereSurface?.parentElement;

    expect(atmosphere).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelectorAll('.chat-canvas-atmosphere')).toHaveLength(1);
    expect(atmosphereSurface).toHaveClass('h-full');
    expect(mainPane).toHaveClass('ml-1', 'rounded-xl', 'overflow-hidden');
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass('gap-1', 'h-full', 'bg-background');
    expect(container.firstElementChild).toHaveAttribute('data-agents-page');
    expect(container.querySelectorAll('.unified-sidebar-glass')).toHaveLength(1);
  });

  it('groups Agent setup into three pages', () => {
    render(<SettingsPage onClose={vi.fn()} />);

    const section = screen.getByText('Agent setup').parentElement?.parentElement;
    if (!section) throw new Error('Agent setup section not rendered');
    const labels = within(section)
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(labels).toEqual(['AI providers', 'Plugins', 'Skills & agents']);
  });

  it.each([
    ['Preferences', 'preferences'],
    ['Usage', 'usage'],
    ['Appearance', 'appearance'],
    ['Shortcuts', 'keyboard'],
    ['AI providers', 'models'],
    // Consolidated pages open on their first sub-view; the tab ids stay so deep links keep working.
    ['Plugins', 'integrations'],
    ['Skills & agents', 'skills'],
    ['Permissions', 'permissions'],
  ])('opens %s with its existing %s tab id', (label, tabId) => {
    render(<SettingsPage onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: label }));

    expect(testState.setActiveTab).toHaveBeenLastCalledWith(tabId);
  });

  it.each([
    ['mcp', 'Plugins', 'tab-mcp'],
    ['agents', 'Skills & agents', 'tab-custom-agents'],
    ['hooks', 'Skills & agents', 'tab-hooks'],
  ])('keeps the consolidated nav item active on the %s sub-view', (tabId, label, testId) => {
    testState.activeTab = tabId;

    render(<SettingsPage onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId(testId)).toBeInTheDocument();
  });

  it('renders the models page for its stable deep-link id', () => {
    testState.activeTab = 'models';

    render(<SettingsPage onClose={vi.fn()} />);

    expect(screen.getByTestId('tab-models')).toBeInTheDocument();
  });

  it('retains project loading and empty states', () => {
    testState.projects = { data: undefined, isLoading: true };
    const { rerender } = render(<SettingsPage onClose={vi.fn()} />);

    expect(screen.getByText('Loading projects...')).toBeInTheDocument();

    testState.projects = { data: [], isLoading: false };
    rerender(<SettingsPage onClose={vi.fn()} />);

    expect(screen.getByText('No projects yet. Open a folder to get started.')).toBeInTheDocument();
  });

  it('opens a project by the name the chat sidebar uses', () => {
    testState.projects = {
      data: [
        {
          id: 'project-1',
          name: 'Frink',
          gitRepo: 'frink',
          gitRemoteUrl: 'git@github.com:benord/frink.git',
          path: '/workspace/frink',
        },
      ],
      isLoading: false,
    };

    render(<SettingsPage onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'frink' }));

    expect(testState.setActiveTab).toHaveBeenLastCalledWith('project-project-1');
  });

  // Worktree setup and the AI account are stored per project, so every clone needs its own row.
  it('lists each clone of the same repository, with its path on hover', () => {
    const remote = 'git@github.com:benord/frink.git';
    testState.projects = {
      data: [
        {
          id: 'project-1',
          name: 'frink',
          gitRepo: 'frink',
          gitRemoteUrl: remote,
          path: '/a/frink',
        },
        {
          id: 'project-2',
          name: 'frink',
          gitRepo: 'frink',
          gitRemoteUrl: remote,
          path: '/b/frink',
        },
      ],
      isLoading: false,
    };

    render(<SettingsPage onClose={vi.fn()} />);

    const rows = screen.getAllByRole('button', { name: 'frink' });
    expect(rows.map((row) => row.getAttribute('title'))).toEqual(['/a/frink', '/b/frink']);
    fireEvent.click(rows[1]);
    expect(testState.setActiveTab).toHaveBeenLastCalledWith('project-project-2');
  });

  // The new-chat worktree banner deep-links straight to `project-<id>`.
  it('opens a deep-linked project and highlights its row', () => {
    testState.activeTab = 'project-folder-1';
    testState.projects = {
      data: [
        {
          id: 'folder-1',
          name: 'Inbox',
          gitRepo: null,
          gitRemoteUrl: null,
          path: 'virtual://folders/1-inbox',
        },
      ],
      isLoading: false,
    };

    render(<SettingsPage onClose={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Inbox' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Inbox' })).toHaveAttribute('aria-current', 'page');
  });

  it('falls back to Preferences once a fresh project list confirms the project is gone', () => {
    testState.activeTab = 'project-removed';
    testState.projects = {
      data: [],
      isLoading: false,
      isFetchedAfterMount: true,
      isFetching: false,
    };

    render(<SettingsPage onClose={vi.fn()} />);

    expect(testState.setActiveTab).toHaveBeenLastCalledWith('preferences');
  });

  // A project created a moment ago can be missing from a cached list; only a fresh fetch counts.
  it.each([
    [
      'the cached list has not been refreshed yet',
      { isFetchedAfterMount: false, isFetching: true },
    ],
    ['the list is still refreshing', { isFetchedAfterMount: true, isFetching: true }],
  ])('keeps a deep link while %s', (_state, fetchState) => {
    testState.activeTab = 'project-new';
    testState.projects = { data: [], isLoading: false, ...fetchState };

    render(<SettingsPage onClose={vi.fn()} />);

    expect(testState.setActiveTab).not.toHaveBeenCalled();
  });

  it('shows the Debug destination under Advanced and no Beta tab', () => {
    render(<SettingsPage onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Debug' }));

    expect(testState.setActiveTab).toHaveBeenLastCalledWith('debug');
    expect(screen.queryByRole('button', { name: 'Beta' })).toBeNull();
  });

  it('closes settings on Escape when no dialog layer is open', () => {
    const onClose = vi.fn();
    render(<SettingsPage onClose={onClose} />);
    const settingsHeading = screen.getByText('Settings');

    fireEvent.keyDown(settingsHeading, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes only top dialog layer first, then settings on next Escape', () => {
    const onClose = vi.fn();
    render(<SettingsPage onClose={onClose} />);
    const settingsHeading = screen.getByText('Settings');

    const openDialogLayer = document.createElement('div');
    openDialogLayer.setAttribute('role', 'dialog');
    openDialogLayer.setAttribute('data-state', 'open');
    document.body.appendChild(openDialogLayer);
    try {
      fireEvent.keyDown(settingsHeading, { key: 'Escape' });
      expect(onClose).not.toHaveBeenCalled();

      openDialogLayer.remove();

      fireEvent.keyDown(settingsHeading, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      if (openDialogLayer.isConnected) {
        openDialogLayer.remove();
      }
    }
  });
});
