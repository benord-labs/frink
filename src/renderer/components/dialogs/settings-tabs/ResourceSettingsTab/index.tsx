/**
 * One sub-view of "Skills & agents": a list grouped by where each item applies,
 * in the Plugins directory's row language. The first group starts open; the rest fold to a count.
 */
import { FolderOpen } from 'lucide-react';
import {
  type ComponentType,
  type ReactElement,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from 'react';
import {
  SettingsEmptyState,
  SettingsFoldGroup,
  SettingsNoMatches,
  SettingsSearch,
  SoftButton,
} from '@/components/settings/SettingsList';
import { CopyAcrossDialog } from '@/components/ui/copy-across-dialog';
import { LoadingState } from '@/components/ui/loading-state';
import { trpc } from '@/lib/trpc';
import type { ResourceInfo } from '@/types/resource-info';
import { SubviewActions } from '../SettingsSubviewPage';
import { ResourceRow } from './ResourceRow';

type ResourceSettingsTabConfig = {
  /** Plural noun for the search and loading copy. */
  noun: 'skills' | 'agents' | 'hooks';
  emptyIcon: ComponentType<{ className?: string }>;
  emptyTitle: string;
  emptyBody: string;
  /** How to call an item from chat, shown when its row is open. */
  usage?: (name: string) => ReactNode;
  /** A folder under home that Frink creates at boot, so "Show … folder" always lands somewhere. */
  folder?: string;
};

/** Resource-neutral copy-across call (each tab maps `items` to its own mutation field). */
export type CopyMutationInput = {
  items: { name: string; sourcePath: string }[];
  target: 'global' | 'project';
  projectId?: string;
  mode: 'portable' | 'native';
  activeTool?: 'claude-code' | 'cursor';
};

type Props = {
  config: ResourceSettingsTabConfig;
  items: ResourceInfo[];
  isLoading: boolean;
  /** Omitted for resources that never cross tools (hooks): no gap pill and no Copy across. */
  copyAcross?: { noun: string; onCopy: (input: CopyMutationInput) => void };
};

type Group = { title: string; items: ResourceInfo[] };
type GroupRef = { key: string; title: string };

function matchesQuery(item: ResourceInfo, q: string): boolean {
  return !q || item.name.toLowerCase().includes(q) || !!item.description?.toLowerCase().includes(q);
}

/** Global items share one group; project items group by path, titled by its folder. */
function groupOf(item: ResourceInfo): GroupRef {
  if (item.scope === 'global') return { key: 'global', title: 'All projects' };
  const path = item.projectPath ?? '';
  return { key: `project:${path}`, title: path.split(/[\\/]/).pop() || path || 'Other projects' };
}

/** Global items first, then one group per project path, each filtered by the search. */
function groupItems(items: ResourceInfo[], query: string): [string, Group][] {
  const q = query.trim().toLowerCase();
  const groups = new Map<string, Group>([['global', { title: 'All projects', items: [] }]]);
  for (const item of items.filter((entry) => matchesQuery(entry, q))) {
    const { key, title } = groupOf(item);
    const group = groups.get(key) ?? { title, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups].filter(([, group]) => group.items.length > 0);
}

export function ResourceSettingsTab({ config, items, isLoading, copyAcross }: Props): ReactElement {
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [copyDialogItem, setCopyDialogItem] = useState<ResourceInfo | null>(null);
  const [query, setQuery] = useState('');

  const { data: rawProjects } = trpc.projects.list.useQuery();
  const projects = Array.isArray(rawProjects) ? rawProjects : [];
  const { data: homePath } = trpc.external.getHomePath.useQuery();
  const openInFinderMutation = trpc.external.openInFinder.useMutation();

  const groups = useMemo(() => groupItems(items, query), [items, query]);
  const searching = query.trim() !== '';

  const handleToggle = useCallback((path: string) => {
    setExpandedPath((prev) => (prev === path ? null : path));
  }, []);

  const handleOpenInFinder = useCallback(
    (path: string) => openInFinderMutation.mutate(path),
    [openInFinderMutation],
  );

  const handleCopySubmit = useCallback(
    (target: 'global' | 'project', projectId: string | undefined, mode: 'portable' | 'native') => {
      if (!copyDialogItem) return;
      copyAcross?.onCopy({
        items: [{ name: copyDialogItem.name, sourcePath: copyDialogItem.path }],
        target,
        projectId,
        mode,
        activeTool: copyDialogItem.cliType,
      });
      setCopyDialogItem(null);
    },
    [copyDialogItem, copyAcross],
  );

  const openFolder =
    homePath && config.folder ? (
      <SoftButton onClick={() => handleOpenInFinder(`${homePath}/${config.folder}`)}>
        <FolderOpen className="size-3.5" aria-hidden />
        {`Show ${config.noun} folder`}
      </SoftButton>
    ) : null;

  if (isLoading) {
    return <LoadingState message={`Loading ${config.noun}...`} className="py-16" />;
  }

  if (items.length === 0) {
    return (
      <SettingsEmptyState
        icon={config.emptyIcon}
        title={config.emptyTitle}
        body={config.emptyBody}
        action={openFolder}
      />
    );
  }

  return (
    <div className="space-y-8">
      {openFolder ? <SubviewActions>{openFolder}</SubviewActions> : null}

      <div className="mt-7 flex">
        <SettingsSearch noun={config.noun} value={query} onChange={setQuery} />
      </div>

      {groups.length === 0 ? (
        <SettingsNoMatches noun={config.noun} query={query} />
      ) : (
        groups.map(([key, group], index) => (
          <SettingsFoldGroup
            key={key}
            title={group.title}
            items={group.items}
            itemKey={(item) => item.path}
            defaultOpen={index === 0}
            forceOpen={searching}
            revealKey={expandedPath}
            renderItem={(item) => (
              <ResourceRow
                item={item}
                usage={config.usage}
                isExpanded={expandedPath === item.path}
                onToggle={handleToggle}
                onOpenInFinder={handleOpenInFinder}
                onCopyAcross={copyAcross ? setCopyDialogItem : undefined}
              />
            )}
          />
        ))
      )}

      {copyAcross ? (
        <CopyAcrossDialog
          items={
            copyDialogItem ? [{ name: copyDialogItem.name, sourcePath: copyDialogItem.path }] : []
          }
          noun={copyAcross.noun}
          sourceScope={copyDialogItem?.scope}
          sourceProjectId={projects.find((p) => p.path === copyDialogItem?.projectPath)?.id}
          activeTool={copyDialogItem?.cliType}
          projects={projects}
          onClose={() => setCopyDialogItem(null)}
          onSubmit={handleCopySubmit}
        />
      ) : null}
    </div>
  );
}
