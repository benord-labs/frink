import type { ReactElement } from 'react';
import type { TaskData } from '@/lib/tasks/format-task-message';
import { PromptInput, PromptInputContextItems } from '../../../components/ui/prompt-input';
import { cn } from '../../../lib/utils';
import { ContextItems } from '../components/context-items';
import type { AgentsMentionsEditorHandle } from '../mentions';
import { AgentsMentionsEditor } from '../mentions';
import { agentsChatComposerShellClass } from './chat-composer-shell-classes';
import { LIMITS, STRINGS } from './new-chat-form-constants';

type Image = {
  id: string;
  url: string | null;
  isLoading: boolean;
  filename: string;
  mediaType?: string;
  base64Data?: string;
};

type PastedText = {
  id: string;
  filePath: string;
  filename: string;
  size: number;
  preview: string;
  createdAt: Date;
};

type Props = {
  editorRef: React.RefObject<AgentsMentionsEditorHandle | null>;
  images: Image[];
  pastedTexts: PastedText[];
  attachedTask?: TaskData | null;
  isFocused: boolean;
  isDragOver: boolean;
  isDisabled: boolean;
  isMobileFullscreen: boolean;
  onRemoveImage: (id: string) => void;
  onRemovePastedText: (id: string) => void;
  onRemoveTask?: () => void;
  onMentionTrigger: (params: { searchText: string; rect: DOMRect }) => void;
  onCloseTrigger: () => void;
  onSlashTrigger: (params: { searchText: string; rect: DOMRect }) => void;
  onCloseSlashTrigger: () => void;
  onContentChange: (hasContent: boolean) => void;
  onSubmit: () => void;
  onShiftTab: () => void;
  onPaste: (e: React.ClipboardEvent) => void;
  onFocus: () => void;
  onBlur: () => void;
  /** ID of the active option in the slash command listbox (for aria-activedescendant). */
  slashActiveDescendantId?: string;
  /** ID of the slash command listbox element (for aria-controls). */
  slashCommandListboxId?: string;
  children?: React.ReactNode;
};

/**
 * Editor section with mentions support and context items
 */
export function EditorSection({
  editorRef,
  images,
  pastedTexts,
  attachedTask,
  isFocused,
  isDragOver,
  isDisabled,
  isMobileFullscreen,
  onRemoveImage,
  onRemovePastedText,
  onRemoveTask,
  onMentionTrigger,
  onCloseTrigger,
  onSlashTrigger,
  onCloseSlashTrigger,
  onContentChange,
  onSubmit,
  onShiftTab,
  onPaste,
  onFocus,
  onBlur,
  slashActiveDescendantId,
  slashCommandListboxId,
  children,
}: Props): ReactElement {
  return (
    <PromptInput
      className={agentsChatComposerShellClass(isDragOver, isFocused)}
      maxHeight={LIMITS.INPUT_MAX_HEIGHT}
      onSubmit={onSubmit}
      contextItems={
        <ContextItems
          images={images}
          pastedTexts={pastedTexts}
          attachedTask={attachedTask}
          onRemoveImage={onRemoveImage}
          onRemovePastedText={onRemovePastedText}
          onRemoveTask={onRemoveTask}
        />
      }
    >
      <PromptInputContextItems />
      <AgentsMentionsEditor
        ref={editorRef}
        onTrigger={onMentionTrigger}
        onCloseTrigger={onCloseTrigger}
        onSlashTrigger={onSlashTrigger}
        onCloseSlashTrigger={onCloseSlashTrigger}
        onContentChange={onContentChange}
        onSubmit={onSubmit}
        onShiftTab={onShiftTab}
        placeholder={STRINGS.INPUT_PLACEHOLDER}
        className={cn(
          'max-h-[240px] overflow-y-auto bg-transparent px-0.5 pb-1 pt-0.5',
          isMobileFullscreen ? 'min-h-[56px]' : 'min-h-[44px]',
        )}
        onPaste={onPaste}
        disabled={isDisabled}
        onFocus={onFocus}
        onBlur={onBlur}
        slashActiveDescendantId={slashActiveDescendantId}
        slashCommandListboxId={slashCommandListboxId}
      />
      {children}
    </PromptInput>
  );
}
