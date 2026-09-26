import claudeLogo from '@iconify-icons/simple-icons/claude';
import openaiLogo from '@iconify-icons/ri/openai-fill';
import { iconifyComponent } from '@/lib/utils/iconify-component';
/**
 * The read-only mode / model / auto-review readout carried by both flow bottom surfaces — what the
 * composer's selectors showed, restored now that a running or paused flow replaces the composer.
 */
import { Zap, Sparkles } from 'lucide-react';
import type { ComponentType } from 'react';
import {
  CODEX_FAST_SPEED_MULTIPLIER,
  codexFastTierCredits,
} from '../../../../../../../../shared/lib/codex-cli-models';
import {
  formatModelPickerLabel,
  resolveModelPickerItemById,
} from '../../../../../../../../shared/lib/model-picker-label';
import type { ChatMode } from '../../../../../../../../shared/types/chat-mode';
import { MODE_CONFIG } from '../../../../../components/mode-selector';
import { supportsNativeAutoReview } from '../../../../../lib/resolve-execution-model-cli';
import { HIDE_CONTEXT_PILLS, HIDE_MODEL_TEXT, HIDE_PILL_TEXT } from '../FlowSurfaceCard';

const ClaudeCodeIcon = iconifyComponent(claudeLogo);
const CodexIcon = iconifyComponent(openaiLogo);

const PROVIDER_ICON = { claude: ClaudeCodeIcon, codex: CodexIcon } as const;

const META_PILL_CLASS =
  'inline-flex shrink-0 items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground';
const HIDE_FAST_PILL_TEXT = '@max-[22rem]:sr-only';

/**
 * Whether provider-native auto-review can apply to this node AT ALL — the question the card must
 * answer before it can honestly say "on" or "off".
 *
 * The flow's `autoReviewTools` is a REQUEST, not the effective value: the executor still refuses it
 * for a provider without a native reviewer. (Plan mode no longer refuses it — Auto reviews the
 * planning phase too.) This mirrors that gate from data the surface already carries — the picker id
 * encodes the provider, and `allowClaudeSdkDefault` covers a node that inherits its model instead of
 * overriding one (the executor passes the same flag).
 *
 * Deliberately NOT `shouldEnableNativeAutoReview`: that folds eligibility and consent into a single
 * boolean, and the whole point here is to tell "auto is off" apart from "auto cannot apply".
 *
 * "No model" and "a model id we cannot resolve" are kept APART. They look identical downstream —
 * both yield no variant — but they mean opposite things: no override inherits the Claude SDK
 * default and is eligible, whereas a stale or foreign id tells us nothing about the provider.
 * Treating the latter as Claude would feed the raw id to the Claude version check, which returns
 * true for any string that is not `haiku`, and paint an Auto pill onto a node that can never
 * auto-review. The model pill already hides for an unresolved id; this hides with it.
 */
function isAutoReviewEligible(modelId: string | undefined): boolean {
  if (!modelId) return supportsNativeAutoReview('claude-code', '', { allowClaudeSdkDefault: true });
  const variant = resolveModelPickerItemById(modelId)?.variant;
  if (!variant) return false;
  return supportsNativeAutoReview(variant === 'claude' ? 'claude-code' : variant, modelId);
}

type FlowRunMetaProps = {
  modelId?: string;
  mode?: ChatMode;
  /** The flow's `settings.autoReviewTools`, snapshotted onto the task's `_config` at dispatch. */
  autoReviewTools?: boolean;
  /** The flow's `settings.codexFastMode`, snapshotted onto the task's `_config` at dispatch. */
  codexFastMode?: boolean;
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
 * One builder per chip, each returning its spec or null, so the readout is assembled as data rather
 * than as three branches inside one function. Every chip is independently absent when its value is:
 * a taskless window between nodes, an unknown or stale model id, a node where auto cannot apply.
 *
 * Auto carries no `pillTier` while the other two do. Mode and model are context you chose and can
 * re-read in the flow editor, so they drop out first on a narrow card; Auto is permission state that
 * is not inferable from anywhere else, so it survives one width tier longer.
 */
function autoPill(modelId: string | undefined, requested?: boolean) {
  if (requested === undefined || !isAutoReviewEligible(modelId)) return null;
  return {
    key: 'auto',
    icon: Sparkles,
    label: requested ? 'Auto on' : 'Auto off',
    title: requested
      ? 'Auto Mode on — your provider reviews eligible approval requests'
      : 'Auto Mode off — eligible approval requests ask you',
    tint: requested ? 'bg-accent/60 text-foreground' : '',
    labelTier: HIDE_PILL_TEXT,
  } satisfies PillSpec;
}

/**
 * Fast is shown ONLY when it is on, unlike Auto's on/off pair. A "Fast off" chip would be noise on
 * every standard run; this chip exists because the run is spending a credit multiplier and the
 * composer — where the user's own Fast switch lives — is replaced by this strip while a run is live.
 * Absent for any model with no priority tier, so it never claims a cost that is not being charged.
 */
function fastPill(modelId: string | undefined, requested?: boolean) {
  const credits = codexFastTierCredits(modelId);
  if (requested !== true || credits === null) return null;
  return {
    key: 'fast',
    icon: Zap,
    label: `Fast · ${CODEX_FAST_SPEED_MULTIPLIER}× speed · ${credits}× ChatGPT credits`,
    title: `Fast mode on — ${CODEX_FAST_SPEED_MULTIPLIER}× model speed at ${credits}× ChatGPT credits per turn; API-key pricing differs`,
    tint: 'bg-accent/60 text-foreground',
    labelTier: HIDE_FAST_PILL_TEXT,
  } satisfies PillSpec;
}

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
    icon: PROVIDER_ICON[resolved.variant],
    label,
    title: label,
    pillTier: HIDE_CONTEXT_PILLS,
    labelTier: `max-w-[160px] truncate ${HIDE_MODEL_TEXT}`,
  } satisfies PillSpec;
}

function readoutPills(
  modelId: string | undefined,
  mode: ChatMode | undefined,
  autoReviewTools: boolean | undefined,
  codexFastMode: boolean | undefined,
): PillSpec[] {
  return [
    fastPill(modelId, codexFastMode),
    autoPill(modelId, autoReviewTools),
    modePill(mode),
    modelPill(modelId),
  ].filter((pill) => pill !== null);
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
 *
 * The Auto chip reads on/off only where auto-review is a live axis. Where it can never apply (a
 * model with no provider reviewer) it renders nothing rather than spending scarce width to say
 * "this control does not apply here". Plan mode is now a live axis — Auto reviews the planning phase.
 *
 * That is a display-only narrowing of auto-mode-tool-approval's "on, off, or unavailable" presentation
 * (the pill hides the "unavailable" state for a run surface where width is scarce); the reviewer
 * posture itself is unchanged.
 */
export function FlowRunMeta({
  modelId,
  mode,
  autoReviewTools,
  codexFastMode,
  confirming,
}: FlowRunMetaProps) {
  const pills = readoutPills(modelId, mode, autoReviewTools, codexFastMode);
  if (pills.length === 0) return null;
  return (
    // The chips own their line, so they never compete with the status sentence for width and never
    // need to shrink. They still step aside entirely while Stop is armed: at a 300px pane the armed
    // row needs every pixel for two confirm verbs that must keep their full wording.
    <div className={`flex shrink-0 items-center gap-1.5 ${confirming ? 'sr-only' : ''}`}>
      {pills.map(({ key, ...pill }) => (
        <MetaPill key={key} {...pill} />
      ))}
    </div>
  );
}
