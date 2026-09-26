import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { IDE_ORIGIN_LABELS } from '@/constants/ide-origins';
import { getDisplayFolderName } from '@/lib/utils/path';

const RESOURCE_TYPE_LABELS: Record<string, string> = {
  agents: 'agent',
  skills: 'skill',
  commands: 'command',
  hooks: 'hook',
  mcp: 'MCP server',
};

/** Map resourceType to valid SettingsTab (commands has no tab yet, falls back to agents) */
const RESOURCE_TO_SETTINGS_TAB: Record<string, string> = {
  agents: 'agents',
  skills: 'skills',
  hooks: 'hooks',
  mcp: 'mcp',
  commands: 'agents', // No dedicated commands tab; agents is closest
};

// tRPC query keys are nested arrays: [['router', 'procedure']]
const QUERY_KEY_MAP: Record<string, string[][][]> = {
  agents: [[['agents', 'getAggregatedAgentInfo']]],
  skills: [[['skills', 'getAggregatedSkillInfo']]],
  commands: [[['commands', 'list']]],
  hooks: [[['hooks', 'getAggregatedHookInfo']]],
  mcp: [
    [['mcp', 'getAggregatedMcpInfo']],
    [['mcp', 'listGlobalServers']],
    [['claude', 'getAllMcpConfig']],
  ],
};

const TRAILING_SLASHES = /\/+$/;

/** Normalize a filesystem path for comparison (lowercase, no trailing slash). */
function normalizePath(p: string): string {
  return p.replace(TRAILING_SLASHES, '').toLowerCase();
}

/** Optional split-view context so the toast can indicate which pane(s) are affected. */
export type IdeWatcherPaneContext = {
  chatIds: (string | null)[];
  /** chatId → local project/worktree path */
  projectPaths: Map<string, string>;
};

/**
 * Resolve which 1-indexed pane numbers match a worktreePath.
 * Uses startsWith so a worktree sub-directory still matches its parent project.
 */
function matchingPaneNumbers(worktreePath: string, ctx: IdeWatcherPaneContext): number[] {
  const normalized = normalizePath(worktreePath);
  const panes: number[] = [];
  ctx.chatIds.forEach((chatId, idx) => {
    if (!chatId) return;
    const panePath = ctx.projectPaths.get(chatId);
    if (!panePath) return;
    const normalizedPane = normalizePath(panePath);
    if (
      normalized === normalizedPane ||
      normalized.startsWith(`${normalizedPane}/`) ||
      normalizedPane.startsWith(`${normalized}/`)
    ) {
      panes.push(idx + 1); // 1-indexed to match sidebar badges
    }
  });
  return panes;
}

/**
 * Hook that listens for IDE config directory changes (e.g. .cursor/agents/, .claude/skills/)
 * and shows a toast notification prompting the user to import new resources.
 *
 * When `paneContext` is provided (split view active with 2+ panes) the toast description
 * includes the matching pane number(s) so users know which panel is affected.
 */
export function useIdeConfigWatcher(paneContext?: IdeWatcherPaneContext): void {
  const queryClient = useQueryClient();
  const toastTimeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  // Capture latest pane context in a ref so the debounced callback reads fresh state
  const paneCtxRef = useRef(paneContext);
  paneCtxRef.current = paneContext;

  useEffect(() => {
    const cleanup = window.desktopApi?.onIdeConfigChanged?.((data) => {
      // Collect unique query keys and toast keys across the entire batch
      const keysToInvalidate = new Set<string>();

      for (const change of data.changes) {
        // Deduplicate query invalidations across the batch (invalidate for all change types)
        const queryKeys = QUERY_KEY_MAP[change.resourceType] || [];
        for (const key of queryKeys) {
          keysToInvalidate.add(JSON.stringify(key));
        }

        // Only show toast for additions/modifications, not deletions
        if (change.type === 'unlink') continue;

        // Show toast notification (debounced by type+origin to avoid spam)
        const toastKey = `${change.origin}:${change.resourceType}`;
        const existingTimeout = toastTimeoutsRef.current.get(toastKey);
        if (existingTimeout) {
          clearTimeout(existingTimeout);
        }

        const timeout = setTimeout(() => {
          const resourceLabel = RESOURCE_TYPE_LABELS[change.resourceType] || change.resourceType;
          const originLabel = IDE_ORIGIN_LABELS[change.origin] || change.origin;
          const folderName = getDisplayFolderName(data.worktreePath) || '';
          const locationSuffix = folderName ? ` in ${folderName}` : '';

          // In split view, append pane number(s) so the user knows which panel is affected
          let paneSuffix = '';
          const ctx = paneCtxRef.current;
          if (ctx && ctx.chatIds.length > 1 && data.worktreePath) {
            const panes = matchingPaneNumbers(data.worktreePath, ctx);
            if (panes.length === 1) {
              paneSuffix = ` (Pane ${panes[0]})`;
            } else if (panes.length > 1) {
              paneSuffix = ` (Panes ${panes.join(', ')})`;
            }
          }

          toast.info(`New ${resourceLabel}(s) detected in ${originLabel}`, {
            id: toastKey, // Stable ID — replaces existing toast instead of stacking duplicates
            description: `Found${locationSuffix}${paneSuffix}. Open Settings to view.`,
            action: {
              label: 'Open Settings',
              onClick: () => {
                const settingsTab = RESOURCE_TO_SETTINGS_TAB[change.resourceType] || 'agents';
                window.dispatchEvent(
                  new CustomEvent('frink:open-settings', {
                    detail: { tab: settingsTab },
                  }),
                );
              },
            },
            duration: 8000,
          });
          toastTimeoutsRef.current.delete(toastKey);
        }, 2000); // 2s debounce — directory copies trigger many file events

        toastTimeoutsRef.current.set(toastKey, timeout);
      }

      // Invalidate each unique query key once (only refetch active queries to avoid background load)
      for (const serialized of keysToInvalidate) {
        queryClient.invalidateQueries({
          queryKey: JSON.parse(serialized) as string[][],
          refetchType: 'active',
        });
      }
    });

    return () => {
      cleanup?.();
      // Clear pending timeouts
      for (const timeout of toastTimeoutsRef.current.values()) {
        clearTimeout(timeout);
      }
      toastTimeoutsRef.current.clear();
    };
  }, [queryClient]);
}
