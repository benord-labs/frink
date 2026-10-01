import type { ReactElement } from 'react';
import type { ChatMode } from '../../../../shared/types/chat-mode';
import type { CodexSpeed } from '../../../../shared/types/execution';
import { PromptInputActions } from '../../../components/ui/prompt-input';
import { AgentSendButton } from '../components/agent-send-button';
import { StagedAutoModeToggle } from '../components/auto-mode-toggle';
import { ComposerAttachButton } from '../components/ComposerAttachButton';
import { ModeSelector } from '../components/mode-selector';
import { type ModelItem, ModelSelector } from '../components/model-selector';
import { COMPOSER_ACTION_ROW_CLASS } from './chat-composer-shell-classes';
import { LIMITS } from './new-chat-form-constants';

type Props = {
  /** Codex Fast staged by this New Chat form for the chat it creates. */
  codexSpeedRef: { current: CodexSpeed };
  // Mode selector props
  chatMode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  modeDropdownOpen: boolean;
  onModeDropdownOpenChange: (open: boolean) => void;
  modeTooltip: {
    visible: boolean;
    position: { top: number; left: number };
    mode: ChatMode;
  } | null;
  onModeTooltipChange: (
    tooltip: {
      visible: boolean;
      position: { top: number; left: number };
      mode: ChatMode;
    } | null,
  ) => void;
  tooltipTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  hasShownTooltipRef: React.MutableRefObject<boolean>;

  autoMode: React.ComponentProps<typeof StagedAutoModeToggle>;

  // Model selector props
  selectedModel: ModelItem;
  availableModels: ModelItem[];
  onModelChange: (model: ModelItem) => void;
  /** Selects the model list / grouping: Codex, or (default) Claude. */
  modelVariant?: 'claude' | 'codex';
  isModelDropdownOpen: boolean;
  onModelDropdownOpenChange: (open: boolean) => void;
  onOpenModelSettings?: () => void;

  // Attachment props
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  images: unknown[];
  onAttachClick: () => void;
  onFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;

  // Debug mode gating
  disableDebugMode?: boolean;

  // Send button props
  hasContent: boolean;
  isUploading: boolean;
  isSubmitting: boolean;
  onSend: () => void;
};

/**
 * Toolbar with mode selector, model selector, attach button, and send button
 */
export function ActionsToolbar({
  codexSpeedRef,
  chatMode,
  onModeChange,
  modeDropdownOpen,
  onModeDropdownOpenChange,
  modeTooltip,
  onModeTooltipChange,
  tooltipTimeoutRef,
  hasShownTooltipRef,
  autoMode,
  selectedModel,
  availableModels,
  onModelChange,
  modelVariant = 'claude',
  isModelDropdownOpen,
  onModelDropdownOpenChange,
  onOpenModelSettings,
  fileInputRef,
  images,
  onAttachClick,
  onFileInputChange,
  disableDebugMode,
  hasContent,
  isUploading,
  isSubmitting,
  onSend,
}: Props): ReactElement {
  return (
    <PromptInputActions
      className="mt-0.5 w-full gap-2 border-t border-border/35 pt-2.5"
      onClick={(e) => e.stopPropagation()}
    >
      <div className={COMPOSER_ACTION_ROW_CLASS}>
        <ModeSelector
          chatMode={chatMode}
          onModeChange={onModeChange}
          modeDropdownOpen={modeDropdownOpen}
          onDropdownOpenChange={onModeDropdownOpenChange}
          modeTooltip={modeTooltip}
          onTooltipChange={onModeTooltipChange}
          tooltipTimeoutRef={tooltipTimeoutRef}
          hasShownTooltipRef={hasShownTooltipRef}
          disableDebugMode={disableDebugMode}
        />

        <StagedAutoModeToggle {...autoMode} />

        <ModelSelector
          selectedModel={selectedModel}
          availableModels={availableModels}
          onModelChange={onModelChange}
          modelVariant={modelVariant}
          isOpen={isModelDropdownOpen}
          onOpenChange={onModelDropdownOpenChange}
          onOpenModelSettings={onOpenModelSettings}
          newChatSpeedRef={codexSpeedRef}
        />
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <input
          type="file"
          ref={fileInputRef}
          hidden
          accept="image/jpeg,image/png"
          multiple
          onChange={onFileInputChange}
        />
        <ComposerAttachButton
          label="Attach image"
          onClick={onAttachClick}
          disabled={images.length >= LIMITS.MAX_IMAGES}
        />
        <div className="ml-1">
          <AgentSendButton
            isStreaming={false}
            isSubmitting={isSubmitting}
            disabled={Boolean(!hasContent || isUploading)}
            onClick={onSend}
            chatMode={chatMode}
            hasContent={hasContent}
          />
        </div>
      </div>
    </PromptInputActions>
  );
}
