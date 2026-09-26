import mcpLogo from '@iconify-icons/simple-icons/modelcontextprotocol';
import { iconifyComponent } from '@/lib/utils/iconify-component';
/* eslint-disable max-lines, max-lines-per-function */
/**
 * SettingsPage Component
 * Full-page settings view (replaces modal dialog)
 */

import { Button } from '@benord-labs/frink-primitives';
import { useAtom, useAtomValue } from 'jotai';
import {
  Box,
  Folder,
  Gauge,
  GitBranch,
  PlugZap,
  Shield,
  X,
  Brain,
  Bug,
  Eye,
  Keyboard,
  Settings,
  ToolCase,
} from 'lucide-react';
import { useEffect } from 'react';
import { isBuildProjectPath } from '@/lib/build-project';
import { ChatAtmosphereSurface } from '../../../components/ChatAtmosphereSurface';
import { AgentsCustomAgentsTab } from '../../../components/dialogs/settings-tabs/AgentsCustomAgentsTab';
import { AgentsHooksTab } from '../../../components/dialogs/settings-tabs/AgentsHooksTab';
import { AgentsMcpTab } from '../../../components/dialogs/settings-tabs/AgentsMcpTab';
import { AgentsModelsTab } from '../../../components/dialogs/settings-tabs/AgentsModelsTab';
import { AgentsPermissionsTab } from '../../../components/dialogs/settings-tabs/AgentsPermissionsTab';
import { AgentsSkillsTab } from '../../../components/dialogs/settings-tabs/AgentsSkillsTab';
import { AgentsUsageTab } from '../../../components/dialogs/settings-tabs/AgentsUsageTab';
import {
  type SettingsSubview,
  SettingsSubviewPage,
} from '../../../components/dialogs/settings-tabs/SettingsSubviewPage';
// Import all tab components
import { AgentsAppearanceTab } from '../../../components/dialogs/settings-tabs/agents-appearance-tab';
import { AgentsDebugTab } from '../../../components/dialogs/settings-tabs/agents-debug-tab';
import { AgentsKeyboardTab } from '../../../components/dialogs/settings-tabs/agents-keyboard-tab';
import { AgentsPreferencesTab } from '../../../components/dialogs/settings-tabs/agents-preferences-tab';
import { ProjectSettingsTab } from '../../../components/dialogs/settings-tabs/ProjectSettingsTab';
import { SidebarMainPaneLayout } from '../../../components/SidebarMainPaneLayout';
import { Kbd } from '../../../components/ui/kbd';
import { ResizableSidebar } from '../../../components/ui/resizable-sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import {
  agentsSettingsDialogActiveTabAtom,
  agentsSidebarWidthAtom,
  devToolsUnlockedAtom,
  type SettingsTab,
} from '../../../lib/atoms';
import { hasOpenDialogLayer } from '../../../lib/has-open-dialog-layer';
import { isEditableKeyboardTarget } from '../../../lib/is-editable-keyboard-target';
import { trpc } from '../../../lib/trpc';
import { Integrations } from '../../integrations';
import { SidebarNavList } from '../../sidebar/components/SidebarNavList';
import { SidebarNavRow } from '../../sidebar/components/SidebarNavRow';
import { SidebarSectionLabel } from '../../sidebar/components/SidebarSectionLabel';
import { SIDEPANE_MAX_WIDTH, SIDEPANE_MIN_WIDTH } from '../../sidebar/constants';
import { InsetGlassSidebarShell } from '../../sidebar/inset-glass-sidebar-shell';

const OriginalMCPIcon = iconifyComponent(mcpLogo);

// Check if we're in development mode
const isDevelopment = import.meta.env.DEV;

type Props = {
  onClose: () => void;
};

type StaticSettingsTab = Exclude<SettingsTab, `project-${string}`>;
type SettingsTabDefinition = {
  id: StaticSettingsTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** A consolidated page's one sentence, fixed across its sub-views. */
  description?: string;
  /** A consolidated page's sub-views; the item is active on any of their tab ids. */
  views?: readonly [SettingsSubview, ...SettingsSubview[]];
};
type SettingsNavSection = {
  label: string;
  tabs: readonly SettingsTabDefinition[];
};

const SETTINGS_NAV_SECTIONS: readonly SettingsNavSection[] = [
  {
    label: 'General',
    tabs: [
      { id: 'preferences', label: 'Preferences', icon: Settings },
      { id: 'usage', label: 'Usage', icon: Gauge },
      { id: 'appearance', label: 'Appearance', icon: Eye },
      { id: 'keyboard', label: 'Shortcuts', icon: Keyboard },
    ],
  },
  {
    label: 'Agent setup',
    tabs: [
      { id: 'models', label: 'AI providers', icon: Brain },
      {
        id: 'integrations',
        label: 'Plugins',
        description: 'Connect the apps your agents work with, like GitHub, Linear and Slack.',
        icon: PlugZap,
        views: [
          { id: 'integrations', label: 'Directory' },
          { id: 'mcp', label: 'MCP servers' },
        ],
      },
      {
        id: 'skills',
        label: 'Skills & agents',
        description: 'Reusable skills and specialist agents your AI can call on.',
        icon: ToolCase,
        views: [
          { id: 'skills', label: 'Skills' },
          { id: 'agents', label: 'Custom agents' },
          { id: 'hooks', label: 'Hooks' },
        ],
      },
    ],
  },
  {
    label: 'Security',
    tabs: [{ id: 'permissions', label: 'Permissions', icon: Shield }],
  },
];

// Dev-only tabs
const DEV_TABS: readonly SettingsTabDefinition[] = [
  {
    id: 'debug',
    label: 'Debug',
    icon: Bug,
  },
];

type ProjectRow = {
  id: string;
  name: string;
  path: string;
  gitRepo: string | null;
  gitRemoteUrl: string | null;
};

/** Same name the chat sidebar shows for the project. */
function projectLabel(project: ProjectRow): string {
  return project.gitRepo ?? project.name;
}

function projectIcon(project: ProjectRow) {
  if (isBuildProjectPath(project.path)) return Box;
  return project.gitRemoteUrl ? GitBranch : Folder;
}

const SUBVIEW_PAGES = SETTINGS_NAV_SECTIONS.flatMap((section) => section.tabs).filter(
  (tab) => tab.views,
);

function isNavItemActive(tab: SettingsTabDefinition, activeTab: SettingsTab): boolean {
  return tab.views ? tab.views.some((view) => view.id === activeTab) : tab.id === activeTab;
}

function renderSubview(id: SettingsTab, onDetailChange: (open: boolean) => void) {
  switch (id) {
    case 'integrations':
      return <Integrations onDetailChange={onDetailChange} />;
    case 'mcp':
      return <AgentsMcpTab />;
    case 'skills':
      return <AgentsSkillsTab />;
    case 'agents':
      return <AgentsCustomAgentsTab />;
    case 'hooks':
      return <AgentsHooksTab />;
    default:
      return null;
  }
}

type SettingsNavItemProps = {
  tab: SettingsTabDefinition;
  isActive: boolean;
  onSelect: (tab: SettingsTab) => void;
};

function SettingsNavItem({ tab, isActive, onSelect }: SettingsNavItemProps) {
  return (
    <SidebarNavRow
      icon={<tab.icon />}
      label={tab.label}
      active={isActive}
      onClick={() => onSelect(tab.id)}
      aria-current={isActive ? 'page' : undefined}
    />
  );
}

export function SettingsPage({ onClose }: Props) {
  const [activeTab, setActiveTab] = useAtom(agentsSettingsDialogActiveTabAtom);
  const devToolsUnlocked = useAtomValue(devToolsUnlockedAtom);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== 'Escape') {
        return;
      }

      if (isEditableKeyboardTarget(event.target)) {
        return;
      }

      if (hasOpenDialogLayer()) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      onClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const {
    data: projects,
    isLoading: isProjectsLoading,
    isFetchedAfterMount,
    isFetching,
  } = trpc.projects.list.useQuery(undefined, { refetchOnMount: 'always' });
  // A `project-<id>` tab can outlive its project (removed from the sidebar, or a stale deep link).
  // Only a fresh list can say so: a project created a moment ago may be missing from the cache.
  const isMissingProject =
    isFetchedAfterMount &&
    !isFetching &&
    !!projects &&
    !!activeTab?.startsWith('project-') &&
    !projects.some((project) => `project-${project.id}` === activeTab);
  useEffect(() => {
    if (isMissingProject) setActiveTab('preferences');
  }, [isMissingProject, setActiveTab]);
  const sortedProjects = [...(projects ?? [])].sort((a, b) =>
    projectLabel(a).localeCompare(projectLabel(b)),
  );

  // Show debug tab if in development OR if devtools are unlocked
  const showDebugTab = isDevelopment || devToolsUnlocked;

  // Render active tab content
  const renderTabContent = () => {
    if (!activeTab) return null;

    if (activeTab.startsWith('project-')) {
      const project = projects?.find((p) => `project-${p.id}` === activeTab);
      return project ? (
        <ProjectSettingsTab key={project.id} project={project} title={projectLabel(project)} />
      ) : null;
    }

    // One element per page (same type and key) across its sub-view ids, so the tabs stay mounted.
    const subviewPage = SUBVIEW_PAGES.find((tab) => isNavItemActive(tab, activeTab));
    if (subviewPage?.views) {
      return (
        <SettingsSubviewPage
          key={subviewPage.id}
          title={subviewPage.label}
          description={subviewPage.description}
          views={subviewPage.views}
          renderView={renderSubview}
        />
      );
    }

    switch (activeTab) {
      case 'usage':
        return <AgentsUsageTab />;
      case 'permissions':
        return <AgentsPermissionsTab />;
      case 'models':
        return <AgentsModelsTab />;
      case 'appearance':
        return <AgentsAppearanceTab />;
      case 'keyboard':
        return <AgentsKeyboardTab />;
      case 'preferences':
        return <AgentsPreferencesTab />;
      case 'debug':
        return <AgentsDebugTab />;
      default:
        return null;
    }
  };

  return (
    <SidebarMainPaneLayout
      sidebar={
        <ResizableSidebar
          isOpen
          widthAtom={agentsSidebarWidthAtom}
          minWidth={SIDEPANE_MIN_WIDTH}
          maxWidth={SIDEPANE_MAX_WIDTH}
          side="left"
          showResizeTooltip
          disableClickToClose
          className="shrink-0"
        >
          <InsetGlassSidebarShell edge="left" className="min-w-0">
            <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/30 px-3">
              <span className="text-sm font-medium">Settings</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={onClose}
                    className="shrink-0 rounded-md text-muted-foreground transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] hover:text-foreground"
                    aria-label="Close settings"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="flex items-center gap-2 text-xs">
                  <span>Close settings</span>
                  <Kbd shortcutId="close-settings" />
                </TooltipContent>
              </Tooltip>
            </div>

            <SidebarNavList aria-label="Settings navigation" scrollable>
              {SETTINGS_NAV_SECTIONS.map((section) => (
                <div key={section.label} className="space-y-0.5">
                  <SidebarSectionLabel label={section.label} />
                  {section.tabs.map((tab) => (
                    <SettingsNavItem
                      key={tab.id}
                      tab={tab}
                      isActive={isNavItemActive(tab, activeTab)}
                      onSelect={(tabId) => setActiveTab(tabId)}
                    />
                  ))}
                </div>
              ))}

              <div className="space-y-0.5">
                <SidebarSectionLabel label="Projects" />
                {isProjectsLoading ? (
                  <p className="px-2 py-2 text-xs text-muted-foreground">Loading projects...</p>
                ) : sortedProjects.length === 0 ? (
                  <p className="px-2 py-2 text-xs text-muted-foreground">
                    No projects yet. Open a folder to get started.
                  </p>
                ) : (
                  sortedProjects.map((project) => {
                    const tabId = `project-${project.id}` as const;
                    const Icon = projectIcon(project);
                    return (
                      <SidebarNavRow
                        key={project.id}
                        icon={<Icon />}
                        label={projectLabel(project)}
                        title={project.path}
                        active={activeTab === tabId}
                        onClick={() => setActiveTab(tabId)}
                        aria-current={activeTab === tabId ? 'page' : undefined}
                      />
                    );
                  })
                )}
              </div>

              {showDebugTab && (
                <div className="space-y-0.5">
                  <SidebarSectionLabel label="Advanced" />
                  {DEV_TABS.map((tab) => (
                    <SettingsNavItem
                      key={tab.id}
                      tab={tab}
                      isActive={activeTab === tab.id}
                      onSelect={(tabId) => setActiveTab(tabId)}
                    />
                  ))}
                </div>
              )}
            </SidebarNavList>
          </InsetGlassSidebarShell>
        </ResizableSidebar>
      }
      inset
      className="h-full bg-background"
      data-agents-page
    >
      {/* Content — borderless single-pane chat canvas. */}
      <ChatAtmosphereSurface className="h-full">
        <main className="relative z-10 min-h-0 flex-1 overflow-y-auto">{renderTabContent()}</main>
      </ChatAtmosphereSurface>
    </SidebarMainPaneLayout>
  );
}
