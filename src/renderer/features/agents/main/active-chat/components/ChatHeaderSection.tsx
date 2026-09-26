import type { UIMessage } from 'ai';
import type { ReactElement } from 'react';
import type { TextSelectionSource } from '../../../context/text-selection-context';
import { ChatSearchBar } from '../../../search';
import { ChatTitleEditor } from '../../../ui/chat-title-editor';
import { QuickCommentInput } from '../../../ui/quick-comment-input';
import { TextSelectionPopover } from '../../../ui/text-selection-popover';
import { STRINGS } from '../constants';

type QuickCommentState = {
  selectedText: string;
  source: TextSelectionSource;
  rect: DOMRect;
};

type Props = {
  messages: UIMessage[];
  quickCommentState: QuickCommentState | null;
  addTextContext: (text: string, source: TextSelectionSource) => void;
  handleQuickComment: (text: string, source: TextSelectionSource, rect: DOMRect) => void;
  handleQuickCommentSubmit: (
    comment: string,
    selectedText: string,
    source: TextSelectionSource,
  ) => void | Promise<void>;
  handleQuickCommentCancel: () => void;
  handleFocusInput: () => void;
  isMobile: boolean;
  subChatName: string;
  subChatId: string;
  hasMessages: boolean;
  handleRenameSubChat: (newName: string) => Promise<void>;
  splitPaneIndex?: number;
  isActive?: boolean;
};

/**
 * ChatHeaderSection - Text selection, quick comment, search bar, and title
 * Extracted to reduce complexity in ChatViewInner
 */
export function ChatHeaderSection({
  messages,
  quickCommentState,
  addTextContext,
  handleQuickComment,
  handleQuickCommentSubmit,
  handleQuickCommentCancel,
  handleFocusInput,
  isMobile,
  subChatName,
  subChatId,
  hasMessages,
  handleRenameSubChat,
  splitPaneIndex,
  isActive = true,
}: Props): ReactElement {
  return (
    <>
      {/* Text selection popover - only in active pane so replies go to correct chat */}
      {isActive && (
        <TextSelectionPopover
          onAddToContext={addTextContext}
          onQuickComment={handleQuickComment}
          onFocusInput={handleFocusInput}
        />
      )}

      {/* Quick comment input - only in active pane so portal respects pointer-events isolation */}
      {isActive && quickCommentState && (
        <QuickCommentInput
          selectedText={quickCommentState.selectedText}
          source={quickCommentState.source}
          rect={quickCommentState.rect}
          onSubmit={handleQuickCommentSubmit}
          onCancel={handleQuickCommentCancel}
        />
      )}

      {/* Chat search bar - only shown in the active pane during split view */}
      <ChatSearchBar messages={messages} splitPaneIndex={splitPaneIndex} />

      {/* Chat title (desktop only); a Compact split pane's PaneHeader already shows it */}
      {!isMobile && (
        <div className="shrink-0 pb-2 pt-2 @max-[30rem]/pane:hidden">
          <ChatTitleEditor
            name={subChatName}
            placeholder={STRINGS.NEW_CHAT}
            onSave={handleRenameSubChat}
            isMobile={false}
            chatId={subChatId}
            hasMessages={hasMessages}
          />
        </div>
      )}
    </>
  );
}
