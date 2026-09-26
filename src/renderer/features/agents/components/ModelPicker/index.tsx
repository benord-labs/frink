import { useAtom } from 'jotai';
import { RESET } from 'jotai/utils';
import { ChevronRight, RotateCcw, Settings, Check } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  EFFORT_LABEL,
  findPickerSelection,
  groupPickerModels,
  type PickerFamily,
  type PickerWindow,
  pickInWindow,
} from '../../../../../shared/lib/model-picker-label/groups';
import { Slider } from '../../../../components/ui/slider';
import { extendedThinkingEnabledAtom } from '../../../../lib/atoms';
import { overlayItem } from '../../../../lib/overlay-styles';
import { cn } from '../../../../lib/utils';
import type { ModelItem } from '../model-selector';
import { type FastScope, ICON_BUTTON_CLASS, ProviderToggle } from './ProviderToggle';

/** Shown when the Extra High stop is dropped — a user-reachable action (packaged users update the app). */
const XHIGH_HIDDEN_HINT = 'Extra High needs a newer Claude CLI — update Frink to enable it.';
const ULTRA_HINT = 'Ultra runs many agents in parallel — it uses your usage much faster.';

/** The shared menu-item look (hover, keyboard focus), so the rows read like every other menu. */
const ROW_CLASS = cn(overlayItem, 'w-[calc(100%-0.5rem)] cursor-pointer justify-between text-left');

const SECTION_LABEL_CLASS = 'px-2.5 pt-1.5 pb-1 text-xs font-medium text-muted-foreground';

/** Each pane (and each new effort label) eases in rather than snapping. */
const ENTER = 'animate-in fade-in-0 duration-150 motion-reduce:animate-none';

type Selection = { family: PickerFamily<ModelItem>; window: PickerWindow<ModelItem> };

type Props = {
  models: readonly ModelItem[];
  selectedModel: ModelItem | undefined;
  onSelect: (model: ModelItem) => void;
  variant: 'claude' | 'codex';
  /** Drop the Extra High stop (the bundled Claude CLI cannot run `--effort xhigh`). */
  hideXhigh: boolean;
  /** Codex Fast: per chat, or staged by New Chat for the chat it creates. Absent without a tier. */
  fast?: FastScope;
  /** Flow: the "Agent default" row that clears the stored model. */
  inherit?: { label: string; selected: boolean; onSelect: () => void };
  onOpenModelSettings?: () => void;
  onClose: () => void;
};

/** Two panes: an effort card (slider over the model's tiers) and a model list with context windows.
 *  Opens on the effort card whenever the selected model has an effort choice. */
export function ModelPicker({
  models,
  selectedModel,
  onSelect,
  variant,
  hideXhigh,
  fast,
  inherit,
  onOpenModelSettings,
  onClose,
}: Props): ReactElement {
  const families = useMemo(() => groupPickerModels(models), [models]);
  const current = findPickerSelection(families, selectedModel?.id);
  const tiersOf = (w: PickerWindow<ModelItem>) => visibleTiers(w, hideXhigh, selectedModel?.id);
  const [pane, setPane] = useState<'effort' | 'list'>(
    current && tiersOf(current.window).length > 1 ? 'effort' : 'list',
  );
  const paneRef = usePaneFocus(pane);
  const toggle = <ProviderToggle variant={variant} fast={fast} />;

  if (pane === 'effort' && current && selectedModel) {
    const tiers = tiersOf(current.window);
    return (
      <EffortPane
        paneRef={paneRef}
        toggle={toggle}
        familyLabel={current.family.label}
        tiers={tiers}
        defaultTier={current.window.defaultTier}
        xhighHidden={tiers.length !== current.window.tiers.length}
        selected={selectedModel}
        effortNeedsThinking={variant === 'claude'}
        onSelect={onSelect}
        onShowModels={() => setPane('list')}
      />
    );
  }

  return (
    <ListPane
      paneRef={paneRef}
      toggle={toggle}
      families={families}
      current={current}
      selectedModel={selectedModel}
      inherit={inherit}
      onSelect={onSelect}
      onPickFamily={(f) => {
        // A new family lands on its default context window, keeping the chosen effort.
        onSelect(pickInWindow(f.defaultWindow, selectedModel?.effort));
        if (tiersOf(f.defaultWindow).length > 1) setPane('effort');
        else onClose();
      }}
      onOpenModelSettings={onOpenModelSettings}
      onClose={onClose}
    />
  );
}

/** A window's tiers minus Extra High, and Ultra which runs at it, when the bundled CLI lacks it
 *  (kept if already selected). */
function visibleTiers(
  w: PickerWindow<ModelItem>,
  hideXhigh: boolean,
  selectedId: string | undefined,
): ModelItem[] {
  return w.tiers.filter(
    (t) => !hideXhigh || (t.effort !== 'xhigh' && t.effort !== 'ultra') || t.id === selectedId,
  );
}

/** Focuses the pane's control on open and on every pane switch, one frame late: Radix registers
 *  the slider thumb after mount, and a thumb focused earlier ignores the arrow keys. */
function usePaneFocus(pane: string): RefObject<HTMLDivElement | null> {
  const paneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => focusPaneControl(paneRef.current, pane));
    return () => cancelAnimationFrame(frame);
  }, [pane]);
  return paneRef;
}

/** Toggle left, a centre title, reset right — the row that tops both panes. */
function PaneHeader({
  toggle,
  center,
  onReset,
}: {
  toggle: ReactNode;
  center: ReactNode;
  onReset?: () => void;
}): ReactElement {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
      <div className="justify-self-start">{toggle}</div>
      {center}
      <div className="justify-self-end">
        {onReset ? (
          <button
            type="button"
            className={ICON_BUTTON_CLASS}
            aria-label="Reset to defaults"
            title="Reset to defaults"
            onClick={onReset}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function EffortPane({
  paneRef,
  toggle,
  familyLabel,
  tiers,
  defaultTier,
  xhighHidden,
  selected,
  effortNeedsThinking,
  onSelect,
  onShowModels,
}: {
  paneRef: RefObject<HTMLDivElement | null>;
  toggle: ReactNode;
  familyLabel: string;
  tiers: ModelItem[];
  defaultTier: ModelItem;
  xhighHidden: boolean;
  selected: ModelItem;
  /** Claude: effort only reaches the SDK while Thinking is on, so the slider follows the toggle. */
  effortNeedsThinking: boolean;
  onSelect: (model: ModelItem) => void;
  onShowModels: () => void;
}): ReactElement {
  const [thinkingEnabled, setThinkingEnabled] = useAtom(extendedThinkingEnabledAtom);
  const inert = effortNeedsThinking && !thinkingEnabled;
  const offDefault = !selected.effortDefault;
  const index = Math.max(
    0,
    tiers.findIndex((t) => t.id === selected.id),
  );
  const effortLabel = inert ? 'Thinking off' : effortName(selected);
  // Reset restores both defaults the card shows: the family's default effort and Thinking on.
  const reset = () => {
    if (offDefault) onSelect(defaultTier);
    if (inert) setThinkingEnabled(RESET);
  };
  return (
    <div ref={paneRef} className={cn('flex flex-col gap-3 p-3', ENTER, 'zoom-in-95')}>
      <PaneHeader
        toggle={toggle}
        onReset={offDefault || inert ? reset : undefined}
        center={
          <EffortTitle
            familyLabel={familyLabel}
            effortLabel={effortLabel}
            ultra={selected.effort === 'ultra'}
            inert={inert}
            onClick={onShowModels}
          />
        }
      />
      <Slider
        min={0}
        max={tiers.length - 1}
        step={1}
        value={[index]}
        disabled={inert}
        thumbLabel="Effort"
        onValueChange={([i]) => {
          const next = tiers[i];
          if (next && next.id !== selected.id) onSelect(next);
        }}
      />
      {xhighHidden ? (
        <p className="text-xs leading-snug text-muted-foreground">{XHIGH_HIDDEN_HINT}</p>
      ) : null}
      {selected.effort === 'ultra' && !inert ? (
        <p className="text-xs leading-snug text-muted-foreground">{ULTRA_HINT}</p>
      ) : null}
    </div>
  );
}

function effortName(m: ModelItem): string {
  return m.effort ? EFFORT_LABEL[m.effort] : 'Default';
}

/** The Ultra tier's word, in the animated chroma Frink uses for power keywords (reduced-motion
 *  safe). Text only: the chroma fill is transparent, so it must not wrap `currentColor` icons. */
export function UltraWord(): ReactElement {
  return <span className="chroma-text chroma-text-animate font-medium">Ultra</span>;
}

/** "High ›" over the model name; opens the model list. */
function EffortTitle({
  familyLabel,
  effortLabel,
  ultra,
  inert,
  onClick,
}: {
  familyLabel: string;
  effortLabel: string;
  ultra: boolean;
  inert: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      className="flex flex-col items-center rounded-md px-2 py-0.5 outline-none transition-colors hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-ring/70"
      aria-label={`${familyLabel}, ${effortLabel} effort. Change model`}
      onClick={onClick}
    >
      <span
        key={effortLabel}
        className={cn(
          'flex items-center gap-0.5 text-sm font-medium',
          ENTER,
          'slide-in-from-bottom-1',
          inert ? 'text-muted-foreground' : 'text-primary',
        )}
      >
        {ultra && !inert ? <UltraWord /> : effortLabel}
        <ChevronRight className="h-3.5 w-3.5" />
      </span>
      <span className="text-xs text-muted-foreground">{familyLabel}</span>
    </button>
  );
}

function ListPane({
  paneRef,
  toggle,
  families,
  current,
  selectedModel,
  inherit,
  onSelect,
  onPickFamily,
  onOpenModelSettings,
  onClose,
}: {
  paneRef: RefObject<HTMLDivElement | null>;
  toggle: ReactNode;
  families: PickerFamily<ModelItem>[];
  current: Selection | undefined;
  selectedModel: ModelItem | undefined;
  inherit: Props['inherit'];
  onSelect: (model: ModelItem) => void;
  onPickFamily: (family: PickerFamily<ModelItem>) => void;
  onOpenModelSettings?: () => void;
  onClose: () => void;
}): ReactElement {
  return (
    <div ref={paneRef} className={cn('flex flex-col gap-1 pt-2 pb-1', ENTER)}>
      <div className="px-1">
        <PaneHeader
          toggle={toggle}
          center={<span className="text-xs text-muted-foreground">Select model</span>}
        />
      </div>
      <div role="listbox" aria-label="Select model" onKeyDown={moveOptionFocus}>
        {inherit ? (
          <OptionRow label={inherit.label} selected={inherit.selected} onClick={inherit.onSelect} />
        ) : null}
        {families.map((f) => (
          <OptionRow
            key={f.key}
            label={f.label}
            selected={f === current?.family && !inherit?.selected}
            onClick={() => onPickFamily(f)}
          />
        ))}
      </div>
      {current && selectedModel && current.family.windows.length > 1 ? (
        <ContextWindows current={current} selected={selectedModel} onSelect={onSelect} />
      ) : null}
      {onOpenModelSettings ? (
        <button
          type="button"
          className={cn(ROW_CLASS, 'justify-start text-muted-foreground')}
          onClick={() => {
            onClose();
            onOpenModelSettings();
          }}
        >
          <Settings className="h-3.5 w-3.5 shrink-0" />
          Model visibility & accounts…
        </button>
      ) : null}
    </div>
  );
}

/** The selected family's context windows, default marked — switching keeps the chosen effort. */
function ContextWindows({
  current,
  selected,
  onSelect,
}: {
  current: Selection;
  selected: ModelItem;
  onSelect: (model: ModelItem) => void;
}): ReactElement {
  return (
    <div role="radiogroup" aria-label="Context window" className="border-t border-border/50 pt-1">
      <div className={SECTION_LABEL_CLASS}>Context window</div>
      {current.family.windows.map((w) => (
        <button
          key={w.label}
          type="button"
          role="radio"
          aria-checked={w === current.window}
          className={ROW_CLASS}
          onClick={() => onSelect(pickInWindow(w, selected.effort))}
        >
          <span className="flex items-center gap-1.5">
            {w.label}
            {w.isDefault ? <DefaultBadge /> : null}
          </span>
          {w === current.window ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
        </button>
      ))}
    </div>
  );
}

/** The slider on the effort card; the selected (else first) row on the list. */
function focusPaneControl(root: HTMLElement | null, pane: string) {
  const target =
    pane === 'effort'
      ? root?.querySelector<HTMLElement>('[role="slider"]')
      : (root?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ??
        root?.querySelector<HTMLElement>('[role="option"]'));
  target?.focus();
}

/** Arrow keys walk the list's options, as a menu would. */
function moveOptionFocus(e: KeyboardEvent<HTMLDivElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const options = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]'));
  const at = options.findIndex((o) => o === document.activeElement);
  const next = e.key === 'ArrowDown' ? at + 1 : at - 1;
  options[(next + options.length) % options.length]?.focus();
}

function DefaultBadge(): ReactElement {
  return (
    <span className="inline-flex h-5 items-center rounded-sm border border-border/70 bg-muted/60 px-1.5 text-xs font-medium leading-none text-muted-foreground">
      Default
    </span>
  );
}

function OptionRow({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={ROW_CLASS}
      onClick={onClick}
    >
      <span className="truncate">{label}</span>
      {selected ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
    </button>
  );
}
