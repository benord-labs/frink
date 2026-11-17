import { aiProviderMark } from '@/components/AiProviderMark';
import { cn } from '@/lib/utils';
/**
 * The mode / model readout and the live Auto switch carried by the flow bottom surfaces — what the
 * composer's controls showed, restored now that a running or paused flow replaces the composer.
 */
import { useAtom, useAtomValue } from 'jotai';
import { Rocket, ToggleLeft, ToggleRight, Zap } from 'lucide-react';
import type { ComponentType } from 'react';
import {
  CODEX_FAST_SPEED_MULTIPLIER,
  CODEX_ULTRAFAST_SPEED_MULTIPLIER,
  codexTierCredits,
} from '../../../../../../../../shared/lib/codex-cli-models';
import {
  formatModelPickerLabel,
  resolveModelPickerItemById,
} from '../../../../../../../../shared/lib/model-picker-label';
import type { ChatMode } from '../../../../../../../../shared/types/chat-mode';
import type { CodexSpeed } from '../../../../../../../../shared/types/execution';
import { autoModePerChatAtomFamily, lastSelectedModelIdAtomFamily } from '../../../../../atoms';
import { getAutoModeTogglePresentation } from '../../../../../components/auto-mode-toggle';
import { MODE_CONFIG } from '../../../../../components/mode-selector';
import { supportsNativeAutoReview } from '../../../../../lib/resolve-execution-model-cli';
import { HIDE_CONTEXT_PILLS, HIDE_MODEL_TEXT, HIDE_PILL_TEXT } from '../FlowSurfaceCard';

const META_PILL_CLASS =
  'inline-flex shrink-0 items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground';
const HIDE_FAST_PILL_TEXT = '@max-[22rem]:sr-only';

/** Whether Auto can apply to the chat's next turn: judged on the model that turn sends. An id it
 * cannot resolve hides the switch rather than passing the Claude check for anything but haiku. */
function isAutoReviewEligible(modelId: string): boolean {
  const variant = resolveModelPickerItemById(modelId)?.variant;
  if (!variant) return false;
  return supportsNativeAutoReview(variant === 'claude' ? 'claude-code' : variant, modelId);
}

const AUTO_SWITCH_TIMING =
  'Applies from your next message; the Flow sets it again at its next step.';

/** The chat's own Auto setting, editable mid-run because the composer that owns it is hidden. A flip
 * reaches the next message only, so callers mount it only where a next message can follow. */
export function FlowAutoSwitch({ chatId }: { chatId: string }) {
  const [checked, setChecked] = useAtom(autoModePerChatAtomFamily(chatId));
  const modelId = useAtomValue(lastSelectedModelIdAtomFamily(chatId));
  if (!isAutoReviewEligible(modelId)) return null;
  const { label, text, className } = getAutoModeTogglePresentation({
    checked,
    available: true,
    unavailableReason: '',
  });
  const description = `${label}. ${AUTO_SWITCH_TIMING}`;
  return (
    <button
      type="button"
      aria-pressed={checked}
      aria-label={description}
      title={description}
      onClick={() => setChecked(!checked)}
      className={cn(
        META_PILL_CLASS,
        'cursor-pointer hover:bg-muted hover:text-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring/70',
        className,
      )}
    >
      {checked ? (
        <ToggleRight className="h-3 w-3" aria-hidden />
      ) : (
        <ToggleLeft className="h-3 w-3" aria-hidden />
      )}
      <span className={HIDE_PILL_TEXT}>{text}</span>
    </button>
  );
}

type FlowRunMetaProps = {
  modelId?: string;
  mode?: ChatMode;
  /** The chat whose Auto switch to show; omitted where no next message can follow. */
  autoChatId?: string | null;
  /** The flow's `settings.codexSpeed`, snapshotted onto the task's `_config` at dispatch. */
  codexSpeed?: CodexSpeed;
  /** While Stop is armed the whole readout steps aside — the row becomes the question. */
  confirming?: boolean;
};

/** One readout chip: glyph plus a label that sheds at its own tier. */
type PillSpec = {
  key: string;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  label: string;
  title: string;
  /** Extra chrome for a pill that carries state rather than context. */
  tint?: string;
  /** Width tier at which the whole chip leaves the layout. */
  pillTier?: string;
  /** Width tier at which the chip keeps its glyph but drops its words. */
  labelTier: string;
};

/**
 * Fast is shown ONLY when it is on, unlike Auto's on/off pair. A "Fast off" chip would be noise on
 * every standard run; this chip exists because the run is spending a credit multiplier and the
 * composer — where the user's own Fast switch lives — is replaced by this strip while a run is live.
 * Absent for any model with no priority tier, so it never claims a cost that is not being charged.
 */
function speedPill(modelId: string | undefined, speed: CodexSpeed | undefined) {
  if (speed === undefined || speed === 'standard') return null;
  const credits = codexTierCredits(modelId, speed);
  if (credits === null) return null;
  const { name, icon, pace } = SPEED_PILL[speed];
  return {
    key: 'speed',
    icon,
    label: `${name} · ${pace} speed · ${credits}× ChatGPT credits`,
    title: `${name} mode on — ${pace} model speed at ${credits}× ChatGPT credits per turn; API-key pricing differs`,
    tint: 'bg-accent/60 text-foreground',
    labelTier: HIDE_FAST_PILL_TEXT,
  } satisfies PillSpec;
}

const SPEED_PILL = {
  fast: { name: 'Fast', icon: Zap, pace: `${CODEX_FAST_SPEED_MULTIPLIER}×` },
  ultrafast: {
    name: 'Ultrafast',
    icon: Rocket,
    pace: `up to ${CODEX_ULTRAFAST_SPEED_MULTIPLIER}×`,
  },
} as const;

function modePill(mode: ChatMode | undefined) {
  const config = mode ? MODE_CONFIG[mode] : null;
  if (!config) return null;
  return {
    key: 'mode',
    icon: config.icon,
    label: config.label,
    title: config.tooltip,
    pillTier: HIDE_CONTEXT_PILLS,
    labelTier: HIDE_PILL_TEXT,
  } satisfies PillSpec;
}

function modelPill(modelId: string | undefined) {
  const resolved = modelId ? resolveModelPickerItemById(modelId) : null;
  if (!resolved) return null;
  const label = formatModelPickerLabel(resolved.item);
  return {
    key: 'model',
    icon: aiProviderMark(resolved.variant === 'claude' ? 'claude-code' : resolved.variant),
    label,
    title: label,
    pillTier: HIDE_CONTEXT_PILLS,
    labelTier: `max-w-[160px] truncate ${HIDE_MODEL_TEXT}`,
  } satisfies PillSpec;
}

function readoutPills(
  modelId: string | undefined,
  mode: ChatMode | undefined,
  codexSpeed: CodexSpeed | undefined,
): PillSpec[] {
  return [speedPill(modelId, codexSpeed), modePill(mode), modelPill(modelId)].filter(
    (pill) => pill !== null,
  );
}

function MetaPill({
  icon,
  label,
  title,
  tint = '',
  pillTier = '',
  labelTier,
}: Omit<PillSpec, 'key'>) {
  // biome-ignore lint/style/useNamingConvention: rendered as a component
  const Icon = icon;
  return (
    <span className={`${META_PILL_CLASS} ${tint} ${pillTier}`} title={title}>
      <Icon className="h-3 w-3" aria-hidden />
      <span className={labelTier}>{label}</span>
    </span>
  );
}

/**
 * Reuses the composer's own MODE_CONFIG (icon/label/tooltip), picker-label formatter and Auto Mode
 * copy, so every string here matches what the composer showed before the run replaced it.
 */
export function FlowRunMeta({
  modelId,
  mode,
  autoChatId,
  codexSpeed,
  confirming,
}: FlowRunMetaProps) {
  const pills = readoutPills(modelId, mode, codexSpeed);
  if (pills.length === 0 && !autoChatId) return null;
  return (
    // The chips own their line, so they never compete with the status sentence for width and never
    // need to shrink. They still step aside entirely while Stop is armed: at a 300px pane the armed
    // row needs every pixel for two confirm verbs that must keep their full wording.
    <div className={`flex shrink-0 items-center gap-1.5 ${confirming ? 'sr-only' : ''}`}>
      {autoChatId ? <FlowAutoSwitch chatId={autoChatId} /> : null}
      {pills.map(({ key, ...pill }) => (
        <MetaPill key={key} {...pill} />
      ))}
    </div>
  );
}
