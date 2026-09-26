import { Button } from '@benord-labs/frink-primitives';
import { useAtom } from 'jotai';
import { Lock, Pencil, RotateCcw, Command, ChevronUp, OptionIcon, ArrowBigUp } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { useIsNarrowScreen } from '@/hooks/use-is-narrow-screen';
import { cn } from '@/lib/utils';
import { customHotkeysAtom } from '../../../lib/atoms';
import {
  CATEGORY_LABELS,
  type CustomHotkeysConfig,
  detectConflicts,
  getResolvedHotkey,
  getShortcutAction,
  getShortcutsByCategory,
  hotkeyMatchesQuery,
  hotkeyStringToKeys,
  hotkeyToDisplay,
  isCustomHotkey,
  keysToHotkeyString,
  keyToDisplay,
  type ShortcutAction,
  type ShortcutActionId,
  type ShortcutCategory,
} from '../../../lib/hotkeys';
import { useHotkeyRecorder } from '../../../lib/hotkeys/use-hotkey-recorder';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { SettingsTabHeader } from './SettingsTabHeader';
import { ShortcutSearch } from './ShortcutSearch';
import { SETTINGS_TAB_PAGE_CLASS } from './settings-tab-surface';

const CATEGORY_ORDER: ShortcutCategory[] = ['general', 'workspaces', 'agents', 'files'];

/** Filter each category by label, primary hotkey, or alternate keys. */
function filterShortcuts(
  byCategory: ReturnType<typeof getShortcutsByCategory>,
  rawQuery: string,
  config: CustomHotkeysConfig,
) {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return byCategory;
  const matches = (action: ShortcutAction): boolean => {
    if (action.label.toLowerCase().includes(query)) return true;
    const hotkey = getResolvedHotkey(action.id, config);
    if (hotkey && hotkeyMatchesQuery(hotkey, query)) return true;
    return !!action.altKeys && hotkeyMatchesQuery(keysToHotkeyString(action.altKeys), query);
  };
  const result = { ...byCategory };
  for (const category of CATEGORY_ORDER) result[category] = byCategory[category].filter(matches);
  return result;
}

/** One-line hints: when/why to reach for a shortcut. */
const SHORTCUT_TIPS: Partial<Record<ShortcutActionId, string>> = {
  'show-shortcuts': 'Open this page from anywhere.',
  'close-settings': 'Return to your workspace from Settings.',
  'close-flows': 'Return to your workspace from the flows list.',
  'flow-editor-back-to-list':
    'Back to the flows list once dialogs, the node creator, and side panels are closed.',
  'toggle-sidebar': 'More room for the agent and editor.',
  'new-agent': 'Starts a new workspace in the sidebar, not a tab in this chat.',
  'new-agent-split': 'Add an agent side by side to compare or hand off context.',
  'toggle-files': 'In split view, toggles the file tree of the active pane.',
  'find-in-files': 'Search text across the current project.',
  'editor-toggle-markdown-preview':
    'On macOS this can overlap Paste and Match Style — use the toolbar if needed.',
};

const MODIFIER_ICONS = new Map([
  ['cmd', Command],
  ['meta', Command],
  ['opt', OptionIcon],
  ['alt', OptionIcon],
  ['shift', ArrowBigUp],
  ['ctrl', ChevronUp],
]);

function KeyCap({ keyName }: { keyName: string }): ReactElement {
  const Icon = MODIFIER_ICONS.get(keyName.toLowerCase());
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-border/70 bg-muted/60 px-1.5 font-[inherit] text-xs font-medium text-foreground/80 tabular-nums shadow-[inset_0_-1px_0_0_hsl(var(--border))]">
      {Icon ? <Icon className="h-3 w-3" /> : keyToDisplay(keyName)}
    </kbd>
  );
}

function KeyCaps({ keys }: { keys: string[] }): ReactElement {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((key) => (
        <KeyCap key={key} keyName={key} />
      ))}
    </span>
  );
}

type ShortcutRowProps = {
  action: ShortcutAction;
  keys: string[];
  isCustom: boolean;
  isRecording: boolean;
  error: string | null;
  /** True for a just-rejected recording (announced), false for a standing conflict. */
  isFreshError: boolean;
  onToggleRecording: () => void;
  onRecord: (hotkey: string) => void;
  onCancelRecording: () => void;
  onReset: () => void;
};

/** Input-styled field so the binding reads as editable; clicks bubble to the row. */
function ShortcutBinding({
  action,
  keys,
  isRecording,
  recordingKeys,
}: ShortcutRowProps & { recordingKeys: string[] }): ReactElement {
  if (action.nonRebindable) {
    return (
      <span className="flex items-center gap-2" title="Built in — can't be changed">
        <Lock className="h-3 w-3 text-muted-foreground/60" aria-label="Can't be changed" />
        <KeyCaps keys={keys} />
      </span>
    );
  }
  const showKeys = isRecording ? recordingKeys : keys;
  return (
    <Button
      variant="ghost"
      size="auto"
      aria-label={isRecording ? 'Recording — press a key combination' : `Change ${action.label}`}
      aria-pressed={isRecording}
      className={cn(
        'h-8 min-w-32 justify-between gap-3 rounded-[var(--field-radius)] border bg-field px-1.5 font-normal',
        isRecording
          ? 'border-primary ring-2 ring-primary/25 hover:bg-field'
          : 'border-field-border group-hover:border-foreground/25 hover:bg-field',
      )}
    >
      {showKeys.length > 0 ? (
        <KeyCaps keys={showKeys} />
      ) : (
        <span className={cn('px-1 text-xs text-muted-foreground', isRecording && 'animate-pulse')}>
          {isRecording ? 'Press keys…' : 'Not set'}
        </span>
      )}
      {!isRecording && (
        <Pencil className="mr-0.5 h-3 w-3 text-muted-foreground/50 transition-colors group-hover:text-foreground" />
      )}
    </Button>
  );
}

function ShortcutRow(props: ShortcutRowProps): ReactElement {
  const { action, isCustom, isRecording, error, isFreshError, onToggleRecording, onReset } = props;
  const editable = !action.nonRebindable;
  // A recorder per row: switching rows turns one off and arms the next with fresh key state.
  const { currentKeys } = useHotkeyRecorder({
    isRecording,
    onRecord: props.onRecord,
    onCancel: props.onCancelRecording,
  });
  const hint = isRecording
    ? 'Press the new combination. Esc to cancel.'
    : (SHORTCUT_TIPS[action.id] ??
      (action.contextOnly ? 'Works when the file tree or editor is focused.' : null));

  return (
    <div
      data-shortcut-recorder={editable || undefined}
      onClick={editable ? onToggleRecording : undefined}
      className={cn(
        'group flex items-center justify-between gap-4 px-4 py-2.5 transition-colors',
        editable && 'cursor-pointer hover:bg-muted/30',
        isRecording && 'bg-primary/5 hover:bg-primary/5',
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">{action.label}</span>
        {error ? (
          <span className="text-xs text-destructive" role={isFreshError ? 'alert' : undefined}>
            {error}
          </span>
        ) : hint ? (
          <span className="text-xs leading-relaxed text-muted-foreground">{hint}</span>
        ) : null}
        {action.altKeys && action.altKeys.length > 0 && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Also <KeyCaps keys={action.altKeys} />
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {isCustom && !isRecording && (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            onClick={(e) => {
              e.stopPropagation();
              onReset();
            }}
            title={`Reset to ${hotkeyToDisplay(keysToHotkeyString(getShortcutAction(action.id)?.defaultKeys ?? []))}`}
            aria-label={`Reset ${action.label} to default`}
            className="text-muted-foreground"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        )}
        <ShortcutBinding {...props} recordingKeys={currentKeys} />
      </div>
    </div>
  );
}

export function AgentsKeyboardTab(): ReactElement {
  const isNarrowScreen = useIsNarrowScreen();
  const [customHotkeys, setCustomHotkeys] = useAtom(customHotkeysAtom);
  // One target at a time: a shortcut row or search-by-keys, so a combination is never captured twice.
  const [recordingTarget, setRecordingTarget] = useState<ShortcutActionId | 'search' | null>(null);
  const recordingId = recordingTarget === 'search' ? null : recordingTarget;
  const [error, setError] = useState<{ id: ShortcutActionId; message: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [confirmResetAll, setConfirmResetAll] = useState(false);

  const handleRecord = useCallback(
    (actionId: ShortcutActionId, hotkey: string) => {
      setRecordingTarget(null);
      const candidate = { ...customHotkeys.bindings, [actionId]: hotkey };
      const clash = detectConflicts({ ...customHotkeys, bindings: candidate }).get(actionId)
        ?.conflictingActionIds[0];
      if (clash) {
        const label = getShortcutAction(clash)?.label ?? clash;
        setError({ id: actionId, message: `Already used by “${label}”` });
        return;
      }
      setCustomHotkeys((prev) => ({
        ...prev,
        bindings: { ...prev.bindings, [actionId]: hotkey },
      }));
    },
    [customHotkeys, setCustomHotkeys],
  );

  const cancelRecording = useCallback(() => setRecordingTarget(null), []);
  // Starting never pre-empts a row recording; the re-arm frame can land after a row click.
  const setSearchRecording = useCallback(
    (on: boolean) =>
      setRecordingTarget((cur) => (on ? (cur ?? 'search') : cur === 'search' ? null : cur)),
    [],
  );

  // Clicking anywhere except a binding button cancels an in-progress recording.
  useEffect(() => {
    if (!recordingId) return;
    const handleMouseDown = (e: MouseEvent) => {
      const inRecorder =
        e.target instanceof Element && e.target.closest('[data-shortcut-recorder]');
      if (!inRecorder) cancelRecording();
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [recordingId, cancelRecording]);

  const shortcutsByCategory = useMemo(() => getShortcutsByCategory(), []);
  const conflicts = useMemo(() => detectConflicts(customHotkeys), [customHotkeys]);
  const filtered = useMemo(
    () => filterShortcuts(shortcutsByCategory, searchQuery, customHotkeys),
    [shortcutsByCategory, searchQuery, customHotkeys],
  );
  const customCount = Object.values(customHotkeys.bindings).filter((b) => b !== null).length;
  const hasResults = CATEGORY_ORDER.some((category) => filtered[category].length > 0);

  const toggleRecording = (id: ShortcutActionId) => {
    setError(null);
    setRecordingTarget((current) => (current === id ? null : id));
  };

  const resetBinding = (id: ShortcutActionId) => {
    setError(null);
    setCustomHotkeys((prev) => {
      const { [id]: _, ...bindings } = prev.bindings;
      return { ...prev, bindings };
    });
  };

  const conflictMessage = (id: ShortcutActionId): string | null => {
    if (error?.id === id) return error.message;
    const clash = conflicts.get(id)?.conflictingActionIds[0];
    return clash ? `Conflicts with “${getShortcutAction(clash)?.label ?? clash}”` : null;
  };

  return (
    <div className={cn(SETTINGS_TAB_PAGE_CLASS, 'min-h-0')}>
      <SettingsTabHeader
        title="Shortcuts"
        description="Click any shortcut to record a new key combination."
        narrow={isNarrowScreen}
        actionsRowLayout="inline"
        actions={
          customCount > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setConfirmResetAll(true)}>
              <RotateCcw className="h-3.5 w-3.5" />
              Reset {customCount} changed
            </Button>
          )
        }
      />

      <ShortcutSearch
        query={searchQuery}
        onQueryChange={setSearchQuery}
        isRecording={recordingTarget === 'search'}
        onRecordingChange={setSearchRecording}
      />

      {!hasResults && (
        <p className="py-10 text-center text-sm text-muted-foreground">
          No shortcuts match “{hotkeyToDisplay(searchQuery)}”
        </p>
      )}

      {CATEGORY_ORDER.map((category) =>
        filtered[category].length === 0 ? null : (
          <SettingsSection key={category} title={CATEGORY_LABELS[category]}>
            <SettingsCard>
              <div className="divide-y divide-border/60">
                {filtered[category].map((action) => {
                  const hotkey = getResolvedHotkey(action.id, customHotkeys);
                  return (
                    <ShortcutRow
                      key={action.id}
                      action={action}
                      keys={hotkey ? hotkeyStringToKeys(hotkey) : []}
                      isCustom={isCustomHotkey(action.id, customHotkeys)}
                      isRecording={recordingId === action.id}
                      onRecord={(hotkey) => handleRecord(action.id, hotkey)}
                      onCancelRecording={cancelRecording}
                      error={conflictMessage(action.id)}
                      isFreshError={error?.id === action.id}
                      onToggleRecording={() => toggleRecording(action.id)}
                      onReset={() => resetBinding(action.id)}
                    />
                  );
                })}
              </div>
            </SettingsCard>
          </SettingsSection>
        ),
      )}

      <ConfirmDialog
        open={confirmResetAll}
        onOpenChange={setConfirmResetAll}
        onConfirm={() => setCustomHotkeys({ version: 1, bindings: {} })}
        title="Reset all shortcuts?"
        description={`Your ${customCount} custom ${customCount === 1 ? 'shortcut goes' : 'shortcuts go'} back to the defaults.`}
        confirmLabel="Reset all"
      />
    </div>
  );
}
