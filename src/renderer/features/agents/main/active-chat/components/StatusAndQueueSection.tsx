import type { ReactElement } from 'react';
import { useUncommittedFiles } from '../../../../../lib/agent-chat/use-uncommitted-files';
import { trpc } from '../../../../../lib/trpc';
import type { SubChatFileChange } from '../../../atoms';
import type { AgentQueueItem } from '../../../lib/queue-utils';
import { AgentQueueIndicator } from '../../../ui/agent-queue-indicator';
import { SubChatStatusCard } from '../../../ui/sub-chat-status-card';

type Props = {
  queue: AgentQueueItem[];
  changedFilesForSubChat: SubChatFileChange[];
  parentChatId: string;
  subChatId: string;
  isStreaming: boolean;
  isCompacting: boolean;
  projectPath?: string;
  handleRemoveFromQueue: (itemId: string) => void;
  handleSendFromQueue: (itemId: string, canSteer: boolean) => void;
  handleEditFromQueue: (itemId: string) => void;
  handleReorderQueue: (fromIndex: number, toIndex: number) => void;
  editingItemId: string | null;
  inputHasContent: boolean;
  handleStop: () => Promise<void>;
};

/**
 * Allow-list, not a deny-list: the type is undefined while the query loads, and a deny-list would
 * then advertise "Steer" on a runtime with no channel. Keep in step with `steerActiveTurn`.
 */
function useSteerSupported(parentChatId: string): boolean {
  const { data: resolvedAccount } = trpc.claudeCode.getResolvedAccount.useQuery(
    { chatId: parentChatId },
    { enabled: !!parentChatId, staleTime: 30_000 },
  );
  return resolvedAccount?.type === 'claude-code' || resolvedAccount?.type === 'codex';
}

export function StatusAndQueueSection({
  queue,
  changedFilesForSubChat,
  parentChatId,
  subChatId,
  isStreaming,
  isCompacting,
  projectPath,
  handleRemoveFromQueue,
  handleSendFromQueue,
  handleEditFromQueue,
  handleReorderQueue,
  editingItemId,
  inputHasContent,
  handleStop,
}: Props): ReactElement {
  const steerSupported = useSteerSupported(parentChatId);
  const uncommittedFiles = useUncommittedFiles(changedFilesForSubChat, projectPath, isStreaming);
  const hasCards = queue.length > 0 || uncommittedFiles.length > 0 || undefined;

  return (
    // `data-stacked-cards` squares the top of the surface below (`composer-slot-surface`).
    <div className="px-2 relative z-10" data-stacked-cards={hasCards}>
      {/* The glass cards sit flush on the surface below them (each drops its bottom border), never
          tucked under it: glass behind glass shows through as a denser band. */}
      {/* Same column as that surface, so card and surface share both edges. */}
      <div className="w-full max-w-2xl mx-auto">
        {/* Queue indicator card - top card */}
        {queue.length > 0 && (
          <AgentQueueIndicator
            queue={queue}
            onRemoveItem={handleRemoveFromQueue}
            onSendNow={handleSendFromQueue}
            onEditItem={handleEditFromQueue}
            onReorder={handleReorderQueue}
            editingItemId={editingItemId}
            inputHasContent={inputHasContent}
            isStreaming={isStreaming}
            steerSupported={steerSupported}
          />
        )}
        {/* Status card - bottom card, only while changed files are still uncommitted */}
        {uncommittedFiles.length > 0 && (
          <SubChatStatusCard
            chatId={parentChatId}
            subChatId={subChatId}
            isStreaming={isStreaming}
            isCompacting={isCompacting}
            uncommittedFiles={uncommittedFiles}
            onStop={handleStop}
            hasQueueCardAbove={queue.length > 0}
          />
        )}
      </div>
    </div>
  );
}
