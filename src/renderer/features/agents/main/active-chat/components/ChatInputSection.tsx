import { Button } from '@benord-labs/frink-primitives';
import type { ReactNode } from 'react';
import { memo } from 'react';
import { NoAccountsEmptyState } from '../../../components/no-accounts-empty-state';
import type { PastedTextFile } from '../../../hooks/use-pasted-text-files';
import type { CodeSelectionContext, DiffTextContext } from '../../../lib/queue-utils';
import { ChatInputArea } from '../../chat-input-area';
import type { ComposerForwardedProps } from '../types';

type Props = ComposerForwardedProps & {
  // Required here, optional on ChatInputArea — this surface always supplies them.
  diffTextContexts: DiffTextContext[];
  onRemoveDiffTextContext: (id: string) => void;
  codeSelectionContext: CodeSelectionContext | null;
  onClearCodeSelection: () => void;
  activeFileName: string | null;
  activeFileDismissed: boolean;
  onDismissActiveFile: () => void;
  pastedTexts: PastedTextFile[];
  onAddPastedText: (text: string) => Promise<void>;
  onRemovePastedText: (id: string) => void;
  isMobile: boolean;
  queueLength: number;
  onSendFromQueue: (itemId: string, canSteer: boolean) => void;
  onInputContentChange: (hasContent: boolean) => void;
  /** Whether the resolved execution account is ready (authenticated). When false, the composer is replaced by the reconnect empty state. */
  isResolvedExecutionAccountReady: boolean;
  /** While getResolvedAccount is loading — show composer instead of empty state to avoid a login flash. */
  isLoadingResolvedAccount?: boolean;
  /** When getResolvedAccount failed — show retry instead of no-account empty state. */
  isErrorResolvedAccount?: boolean;
  /** Refetch execution account (shown on error). */
  onRetryResolvedAccount?: () => void;
  /** Unauthenticated account info for the reconnect CTA. Null when no account is configured at all. */
  unauthAccount?: { label: string; type: 'claude-code' | 'codex' } | null;
};

/** ChatInputSection — the composer, or an account state in its place, in ChatDock's stack.
 *  Memoized to stay out of the per-chunk render wave in streaming. */
export const ChatInputSection = memo(function ChatInputSection({
  editorRef,
  fileInputRef,
  onSend,
  onForceSend,
  onStop,
  onCompact,
  isStreaming,
  isCompacting,
  images,
  files,
  onAddAttachments,
  onRemoveImage,
  onRemoveFile,
  isUploading,
  textContexts,
  onRemoveTextContext,
  diffTextContexts,
  onRemoveDiffTextContext,
  codeSelectionContext,
  onClearCodeSelection,
  activeFileName,
  activeFileDismissed,
  onDismissActiveFile,
  pastedTexts,
  onAddPastedText,
  onRemovePastedText,
  messageTokenData,
  subChatId,
  parentChatId,
  teamId,
  repository,
  sandboxId,
  projectPath,
  projectId,
  changedFiles,
  isMobile,
  queueLength,
  onSendFromQueue,
  firstQueueItemId,
  onInputContentChange,
  isResolvedExecutionAccountReady,
  isLoadingResolvedAccount = false,
  isErrorResolvedAccount = false,
  onRetryResolvedAccount,
  unauthAccount = null,
}: Props): ReactNode {
  // Full composer width, like NoAccountsEmptyState's compact card: the transcript scrolls under it.
  const composerCardClass =
    'w-full rounded-2xl composer-slot-surface border border-border glass-float text-center shadow-xs ring-1 ring-inset ring-foreground/4 space-y-3 p-5';

  return isLoadingResolvedAccount ? (
    <ChatInputArea
      editorRef={editorRef}
      fileInputRef={fileInputRef}
      onSend={onSend}
      onForceSend={onForceSend}
      onStop={onStop}
      onCompact={onCompact}
      isStreaming={isStreaming}
      isCompacting={isCompacting}
      images={images}
      files={files}
      onAddAttachments={onAddAttachments}
      onRemoveImage={onRemoveImage}
      onRemoveFile={onRemoveFile}
      isUploading={isUploading}
      textContexts={textContexts}
      onRemoveTextContext={onRemoveTextContext}
      diffTextContexts={diffTextContexts}
      onRemoveDiffTextContext={onRemoveDiffTextContext}
      codeSelectionContext={codeSelectionContext}
      onClearCodeSelection={onClearCodeSelection}
      activeFileName={activeFileName}
      activeFileDismissed={activeFileDismissed}
      onDismissActiveFile={onDismissActiveFile}
      pastedTexts={pastedTexts}
      onAddPastedText={onAddPastedText}
      onRemovePastedText={onRemovePastedText}
      messageTokenData={messageTokenData}
      subChatId={subChatId}
      parentChatId={parentChatId}
      teamId={teamId}
      repository={repository}
      sandboxId={sandboxId}
      projectPath={projectPath}
      projectId={projectId}
      changedFiles={changedFiles}
      isMobile={isMobile}
      queueLength={queueLength}
      onSendFromQueue={onSendFromQueue}
      firstQueueItemId={firstQueueItemId}
      onInputContentChange={onInputContentChange}
    />
  ) : isErrorResolvedAccount ? (
    <div className="relative z-10 min-w-0 px-2 pb-2">
      <div className="mx-auto w-full max-w-2xl">
        <section
          aria-live="polite"
          className={composerCardClass}
          data-testid="resolved-account-error-state"
        >
          <p className="text-sm font-medium text-foreground">Couldn&apos;t load account</p>
          <p className="text-xs text-muted-foreground text-pretty">
            Check your connection and try again.
          </p>
          <Button
            type="button"
            variant="secondary"
            className="w-full max-w-sm"
            onClick={() => onRetryResolvedAccount?.()}
          >
            Retry
          </Button>
        </section>
      </div>
    </div>
  ) : !isResolvedExecutionAccountReady ? (
    <div className="relative z-10 min-w-0 px-2 pb-2">
      <div className="mx-auto w-full max-w-2xl">
        <NoAccountsEmptyState compact existingAccount={unauthAccount} />
      </div>
    </div>
  ) : (
    /* Input - isolated component to prevent re-renders */
    <ChatInputArea
      editorRef={editorRef}
      fileInputRef={fileInputRef}
      onSend={onSend}
      onForceSend={onForceSend}
      onStop={onStop}
      onCompact={onCompact}
      isStreaming={isStreaming}
      isCompacting={isCompacting}
      images={images}
      files={files}
      onAddAttachments={onAddAttachments}
      onRemoveImage={onRemoveImage}
      onRemoveFile={onRemoveFile}
      isUploading={isUploading}
      textContexts={textContexts}
      onRemoveTextContext={onRemoveTextContext}
      diffTextContexts={diffTextContexts}
      onRemoveDiffTextContext={onRemoveDiffTextContext}
      codeSelectionContext={codeSelectionContext}
      onClearCodeSelection={onClearCodeSelection}
      activeFileName={activeFileName}
      activeFileDismissed={activeFileDismissed}
      onDismissActiveFile={onDismissActiveFile}
      pastedTexts={pastedTexts}
      onAddPastedText={onAddPastedText}
      onRemovePastedText={onRemovePastedText}
      messageTokenData={messageTokenData}
      subChatId={subChatId}
      parentChatId={parentChatId}
      teamId={teamId}
      repository={repository}
      sandboxId={sandboxId}
      projectPath={projectPath}
      projectId={projectId}
      changedFiles={changedFiles}
      isMobile={isMobile}
      queueLength={queueLength}
      onSendFromQueue={onSendFromQueue}
      firstQueueItemId={firstQueueItemId}
      onInputContentChange={onInputContentChange}
    />
  );
});
