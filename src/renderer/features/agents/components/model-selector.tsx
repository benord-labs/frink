import claudeLogo from '@iconify-icons/simple-icons/claude';
import openaiLogo from '@iconify-icons/ri/openai-fill';
import { iconifyComponent } from '@/lib/utils/iconify-component';
import { Button } from '@benord-labs/frink-primitives';
import { codexTierCredits } from '../../../../shared/lib/codex-cli-models';
import {
  formatModelPickerLabel,
  formatModelPickerLabelParts,
} from '../../../../shared/lib/model-picker-label';
import type { CodexSpeed, ClaudeSdkEffortLevel } from '../../../../shared/types/execution';
import { ChevronDown } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover';
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';
import {
  COMPOSER_MODEL_CONTROL_CLASS,
  COMPOSER_MODEL_DETAIL_CLASS,
  COMPOSER_MODEL_LABEL_CLASS,
} from '../main/chat-composer-shell-classes';
import { ModelPicker } from './ModelPicker';
import { UltraWord } from './ModelPicker/UltraSwitch';

const ClaudeCodeIcon = iconifyComponent(claudeLogo);
const CodexIcon = iconifyComponent(openaiLogo);

/** Provider → trigger icon, keyed by `modelVariant`. */
const TRIGGER_ICON = { codex: CodexIcon, claude: ClaudeCodeIcon } as const;

export type ModelItem = {
  id: string;
  name: string;
  detail?: string;
  familyId?: string;
  /** Context window; a family offering several is switched inside the effort card. */
  contextLabel?: string;
  /** Effort tier — the picker's slider axis. Absent for models without an effort choice. */
  effort?: ClaudeSdkEffortLevel;
  /** The family's default tier — the slider's reset target. */
  effortDefault?: true;
  /** Claude: Ultra (parallel agents) on for this tier. */
  ultra?: true;
  /** Claude Code: model version label in the picker. */
  version?: string;
};

type ModelSelectorProps = {
  selectedModel: ModelItem | undefined;
  availableModels: readonly ModelItem[];
  onModelChange: (model: ModelItem) => void;
  modelVariant?: 'claude' | 'codex';
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens full-page Settings on the AI providers tab (visibility, accounts). */
  onOpenModelSettings?: () => void;
  /** Chat: compact toolbar trigger + thinking footer. Flow: form trigger + inherit row, no footer. */
  mode?: 'chat' | 'flow';
  /** Flow: label for cleared / inherited selection (trigger + first row). */
  flowInheritLabel?: string;
  /** Flow: clear stored model id (Agent default / inherit). */
  onClearModel?: () => void;
  /** Flow: stored id is not in the current catalog (migration / catalog change). */
  staleModelId?: string;
  /** Optional trigger class override (merged after mode presets). */
  triggerClassName?: string;
  /** Flow: id on trigger for htmlFor from Label. */
  triggerId?: string;
  /** Chat: scopes Codex speed to this chat. Absent on New Chat, which stages it via `newChatSpeedRef`. */
  chatId?: string;
  /** New Chat: the form's staged speed, applied to the chat it creates. */
  newChatSpeedRef?: { current: CodexSpeed };
};

/** Codex speed controls, or none for a model without a paid tier (incl. Claude) or with nowhere
 *  to keep the choice — never a live-but-inert control. Ultrafast is only offered beside Fast. */
function speedScope(
  modelId: string | undefined,
  chatId: string | undefined,
  newChatSpeedRef: { current: CodexSpeed } | undefined,
) {
  const credits = {
    fast: codexTierCredits(modelId, 'fast'),
    ultrafast: codexTierCredits(modelId, 'ultrafast'),
  };
  if (credits.fast === null || (!chatId && !newChatSpeedRef)) return undefined;
  return { chatId, newChatSpeedRef, credits };
}

/** Flow form: middle label must shrink so long model names truncate (min-w-0 + flex-1). */
const FLOW_FORM_TRIGGER_CLASS =
  'flex h-9 w-full min-w-0 items-center gap-2 rounded-[10px] border border-input bg-background px-3 py-2 text-start text-sm text-foreground shadow-xs focus:border-ring focus:outline-hidden focus:ring-[3px] focus:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50 [&>svg:first-child]:size-3.5';

/** Unified trigger label for Claude Code and Codex models. */
function formatTriggerLabel(m: ModelItem | undefined): string {
  return m ? formatModelPickerLabel(m) : '';
}

/** How an Ultra row's label ends (see the Claude catalog); the trigger restyles just this word. */
const ULTRA_LABEL_TAIL = ' · Ultra';

/** Composer trigger text: the name in the foreground and the tier muted. As the composer narrows
 *  the tier and chevron go first; the name goes only when it no longer fits. */
function ComposerTriggerLabel({
  label,
  suffix,
  ultra,
}: {
  label: string;
  suffix?: string;
  ultra: boolean;
}) {
  return (
    <>
      <span className={COMPOSER_MODEL_LABEL_CLASS}>
        {label}
        {suffix ? (
          <span className={cn('text-muted-foreground/70', COMPOSER_MODEL_DETAIL_CLASS)}>
            {ultra ? (
              <>
                {suffix.slice(0, -ULTRA_LABEL_TAIL.length)}
                {' · '}
                <UltraWord />
              </>
            ) : (
              suffix
            )}
          </span>
        ) : null}
      </span>
      <ChevronDown className={cn('h-3 w-3 shrink-0 opacity-50', COMPOSER_MODEL_DETAIL_CLASS)} />
    </>
  );
}

/** Chat trigger text; a missing selection reads "Auto", as the unified label always has. */
function chatTriggerText(m: ModelItem | undefined) {
  const { name, suffix } = m ? formatModelPickerLabelParts(m) : { name: 'Auto', suffix: '' };
  return { label: name + suffix, name, suffix };
}

function flowTriggerText(
  selectedModel: ModelItem | undefined,
  staleModelId: string | undefined,
  flowInheritLabel: string,
): string {
  if (staleModelId) return staleModelId;
  if (!selectedModel) return flowInheritLabel;
  return formatTriggerLabel(selectedModel);
}

/**
 * Model selector for Claude or Codex.
 */
export function ModelSelector({
  selectedModel,
  availableModels,
  onModelChange,
  modelVariant = 'claude',
  isOpen,
  onOpenChange,
  onOpenModelSettings,
  mode = 'chat',
  flowInheritLabel = 'Agent default',
  onClearModel,
  staleModelId,
  triggerClassName,
  triggerId,
  chatId,
  newChatSpeedRef,
}: ModelSelectorProps) {
  const isFlow = mode === 'flow';
  // Grey the Claude Extra High tier when the bundled CLI can't run `--effort xhigh` (< 2.1.173).
  // Cached for the session (staleTime Infinity); defaults true while loading. The executor clamp is
  // the real backstop. Only affects Claude rows.
  const { data: claudeCaps } = trpc.claudeSettings.getBundledClaudeCapabilities.useQuery(
    undefined,
    {
      staleTime: Number.POSITIVE_INFINITY,
    },
  );
  const xhighSupported = claudeCaps?.supportsXhigh ?? true;
  const ultraSupported = claudeCaps?.supportsUltra ?? true;
  // Ultra is a mode: its word takes the animated chroma used for power keywords.
  const ultra = !isFlow && Boolean(selectedModel?.ultra);
  // biome-ignore lint/style/useNamingConvention: Renders as a component
  const TriggerIcon = TRIGGER_ICON[modelVariant];

  // Chat: the composer's model control (icon, name, muted tier, each shed in turn as it narrows);
  // the full label is its accessible name and hover title. Flow forms keep the labelled field.
  const chatTriggerClass = cn(
    COMPOSER_MODEL_CONTROL_CLASS,
    'outline-offset-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring/70',
  );

  const chatText = chatTriggerText(selectedModel);
  const triggerLabel = isFlow
    ? flowTriggerText(selectedModel, staleModelId, flowInheritLabel)
    : chatText.label;

  return (
    <Popover open={isOpen} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          id={triggerId}
          className={cn(
            isFlow ? FLOW_FORM_TRIGGER_CLASS : chatTriggerClass,
            isFlow && 'text-foreground hover:bg-background',
            triggerClassName,
          )}
          {...(isFlow
            ? {}
            : {
                'aria-label': `Model: ${triggerLabel}${ultra ? ' — parallel agents on' : ''}`,
                title: ultra ? `${triggerLabel} — runs many agents in parallel` : triggerLabel,
              })}
        >
          <TriggerIcon className="h-4 w-4 shrink-0" />
          {isFlow ? (
            <>
              <span className="min-w-0 flex-1 truncate text-left">{triggerLabel}</span>
              <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
            </>
          ) : (
            <ComposerTriggerLabel label={chatText.name} suffix={chatText.suffix} ultra={ultra} />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(248px,92vw)] p-0 outline-none"
        // ModelPicker places focus itself (slider or current row), on open and on each pane switch.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <ModelPicker
          models={availableModels}
          selectedModel={selectedModel}
          onSelect={onModelChange}
          variant={modelVariant}
          hideXhigh={modelVariant === 'claude' && !xhighSupported}
          hideUltra={modelVariant === 'claude' && !ultraSupported}
          speed={isFlow ? undefined : speedScope(selectedModel?.id, chatId, newChatSpeedRef)}
          inherit={
            isFlow
              ? {
                  label: flowInheritLabel,
                  selected: !selectedModel && !staleModelId,
                  onSelect: () => {
                    onClearModel?.();
                    onOpenChange(false);
                  },
                }
              : undefined
          }
          onOpenModelSettings={onOpenModelSettings}
          onClose={() => onOpenChange(false)}
        />
      </PopoverContent>
    </Popover>
  );
}
