import type { ReactElement, ReactNode } from 'react';
import { ChatAtmosphereSurface } from '@/components/ChatAtmosphereSurface';
import { OpenSidebarButton } from '@/components/ui/open-sidebar-button';
import { AgentsContent } from '@/features/agents';
import { CodeEditorPanel } from '@/features/code-editor';
import { FlowsPage } from '@/features/flows';
import { SettingsPage } from '@/features/settings';
import { WorkQueue } from '@/features/work-queue';
import type { ActiveOverlay } from '@/lib/atoms';
import { cn } from '@/lib/utils';

type Props = {
  activeOverlay: ActiveOverlay;
  isMobile: boolean;
  onCloseOverlay: () => void;
  onCloseSettings: () => void;
  onRequestWorkQueueClose: () => void;
  onNavigateWorkQueueToChat: (chatId: string) => void;
  /**
   * Sidebar-reopen affordance state. `canToggle` must come from the layout view policy rather than
   * a raw `isMobile` check — the two diverge on the Flows destination, where the dashboard offers
   * the sidebar and the editor does not.
   */
  sidebar?: { canToggle: boolean; isOpen: boolean; onOpen: () => void };
};

/**
 * Both sidebar-capable destinations are centred columns with an empty top-left corner, so the
 * trigger is positioned out of flow rather than taking a reserved slot ahead of the title.
 */
function renderSidebarTrigger(sidebar: Props['sidebar']): ReactNode {
  if (!sidebar?.canToggle || sidebar.isOpen) {
    return undefined;
  }
  return (
    <OpenSidebarButton
      isSidebarOpen={sidebar.isOpen}
      onOpenSidebar={sidebar.onOpen}
      reserveLayoutSpace={false}
    />
  );
}

/** The one mounted surface for each mutually exclusive Agents destination. */
export function AgentsDestinationPane({
  activeOverlay,
  isMobile,
  onCloseOverlay,
  onCloseSettings,
  onRequestWorkQueueClose,
  onNavigateWorkQueueToChat,
  sidebar,
}: Props): ReactElement {
  const sidebarTrigger = renderSidebarTrigger(sidebar);

  if (activeOverlay === 'flows') {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <CodeEditorPanel />
        <ChatAtmosphereSurface className="bg-background">
          <FlowsPage onClose={onCloseOverlay} sidebarTrigger={sidebarTrigger} />
        </ChatAtmosphereSurface>
      </div>
    );
  }

  if (activeOverlay === 'settings') {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <CodeEditorPanel />
        <SettingsPage onClose={onCloseSettings} />
      </div>
    );
  }

  const isWorkQueue = activeOverlay === 'workqueue';

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {isWorkQueue && isMobile ? null : (
        <div className={isWorkQueue ? 'hidden' : 'contents'}>
          <CodeEditorPanel />
        </div>
      )}
      <section
        aria-label="Chat"
        className={cn('flex min-h-0 flex-1 flex-col overflow-hidden', isWorkQueue && 'hidden')}
        aria-hidden={isWorkQueue || undefined}
        data-work-queue-return-target
        inert={isWorkQueue || undefined}
        tabIndex={-1}
      >
        <AgentsContent />
      </section>
      {isWorkQueue ? (
        <ChatAtmosphereSurface className="bg-background" data-agents-destination="workqueue">
          <WorkQueue
            onRequestClose={onRequestWorkQueueClose}
            onNavigateToChat={onNavigateWorkQueueToChat}
            sidebarTrigger={sidebarTrigger}
          />
        </ChatAtmosphereSurface>
      ) : null}
    </div>
  );
}
