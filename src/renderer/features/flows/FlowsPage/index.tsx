/**
 * Full-page Flows: list + linear editor.
 */

import { Button } from '@benord-labs/frink-primitives';
import { useAtom } from 'jotai';
import { X } from 'lucide-react';
import { type ReactElement, type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  AGENTS_PAGE_COLUMN_CLASS,
  agentsPageHeaderClass,
} from '../../../components/ChatAtmosphereSurface/constants';
import { Kbd } from '../../../components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import { flowsSelectedFlowIdAtom } from '../../../lib/atoms';
import { hasOpenDialogLayer } from '../../../lib/has-open-dialog-layer';
import { isEditableKeyboardTarget } from '../../../lib/is-editable-keyboard-target';
import { appStore } from '../../../lib/jotai-store';
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';
import { UNIFIED_GLASS_INNER_CLASS } from '../../sidebar/inset-glass-sidebar-shell';
import { CreateFlowDialog } from '../CreateFlowDialog';
import { FlowEditor } from '../FlowEditor';
import { FlowsList } from '../FlowsList';

type FlowsPageProps = {
  onClose: () => void;
  /** Sidebar-reopen affordance, rendered ahead of the title. Absent while the sidebar is open. */
  sidebarTrigger?: ReactNode;
};

export function FlowsPage({ onClose, sidebarTrigger }: FlowsPageProps): ReactElement {
  const [selectedFlowId, setSelectedFlowId] = useAtom(flowsSelectedFlowIdAtom);
  const [createOpen, setCreateOpen] = useState(false);
  const { data: flows } = trpc.flows.list.useQuery(undefined);
  const isEmpty = flows !== undefined && flows.length === 0;

  // Exit never prompts: unsaved edits are autosaved as a local draft and restored on reopen.
  const requestClose = useCallback(() => {
    setSelectedFlowId(null);
    onClose();
  }, [onClose, setSelectedFlowId]);

  const handleBackFromEditor = useCallback(() => {
    setSelectedFlowId(null);
  }, [setSelectedFlowId]);

  const handleCreated = useCallback(
    (id: string) => {
      setSelectedFlowId(id);
    },
    [setSelectedFlowId],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Read out-of-render so the listener isn't re-registered on every selection
      // change. Must be `appStore` — the app's Provider store, not jotai's default.
      if (appStore.get(flowsSelectedFlowIdAtom)) {
        return;
      }
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
      requestClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [requestClose]);

  if (selectedFlowId) {
    // Full-width takeover: the canvas keeps its own inset glass frame rather than the page column.
    return (
      <div
        className="relative z-10 flex h-full min-h-0 w-full flex-col overflow-hidden p-2"
        data-agents-page
      >
        <div className={cn(UNIFIED_GLASS_INNER_CLASS, 'h-full min-h-0 min-w-0 rounded-xl')}>
          <FlowEditor key={selectedFlowId} flowId={selectedFlowId} onBack={handleBackFromEditor} />
        </div>
        <CreateFlowDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={handleCreated}
        />
      </div>
    );
  }

  return (
    <main className={AGENTS_PAGE_COLUMN_CLASS} data-agents-page aria-labelledby="flows-heading">
      <header className={agentsPageHeaderClass(Boolean(sidebarTrigger))}>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {sidebarTrigger}
          <h1 id="flows-heading" className="truncate text-xl font-semibold text-foreground">
            Flows
          </h1>
          {flows !== undefined && flows.length > 0 && (
            <span
              className="text-xl font-normal tabular-nums text-muted-foreground"
              aria-label={`${flows.length} ${flows.length === 1 ? 'flow' : 'flows'}`}
            >
              {flows.length}
            </span>
          )}
        </div>
        {/* The header is a window drag region, so its controls must opt back out to stay clickable. */}
        <div className="no-drag flex shrink-0 items-center gap-1.5">
          {!isEmpty && (
            <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
              New flow
            </Button>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                aria-label="Close flows"
                onClick={requestClose}
                iconOnly
              >
                <X className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="flex items-center gap-2 text-xs">
              <span>Close flows</span>
              <Kbd shortcutId="close-flows" />
            </TooltipContent>
          </Tooltip>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col pt-4">
        <FlowsList onCreateClick={() => setCreateOpen(true)} />
      </div>

      <CreateFlowDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={handleCreated} />
    </main>
  );
}
