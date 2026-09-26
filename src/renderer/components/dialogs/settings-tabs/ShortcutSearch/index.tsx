import { Button, Input } from '@benord-labs/frink-primitives';
import { Keyboard, Search, X } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { hotkeyToDisplay } from '../../../../lib/hotkeys';
import { useHotkeyRecorder } from '../../../../lib/hotkeys/use-hotkey-recorder';

/**
 * US-layout base keys and their shifted characters, index-aligned. On macOS with Cmd held,
 * e.key returns the base key, so the recorder captures "cmd+shift+/" when the user means "cmd+?".
 */
const BASE_KEYS = "/1234567890-=[]\\;',.`";
const SHIFTED_KEYS = '?!@#$%^&*()_+{}|:"<>~';

/** Normalize a recorded search combo: cmd+shift+/ and cmd+shift+? both become cmd+?. */
function normalizeSearchRecording(hotkey: string): string {
  const parts = hotkey.split('+');
  const modifiers = ['cmd', 'meta', 'ctrl', 'opt', 'alt', 'shift'];
  const mods = parts.filter((p) => modifiers.includes(p));
  const key = parts.find((p) => !modifiers.includes(p));

  if (!key || !mods.includes('shift')) return hotkey;
  const withoutShift = mods.filter((m) => m !== 'shift');
  const baseIndex = key.length === 1 ? BASE_KEYS.indexOf(key) : -1;
  if (baseIndex >= 0) return [...withoutShift, SHIFTED_KEYS[baseIndex]].join('+');
  // The recorder names the +/= key "plus", which is already the shifted form.
  if (key === 'plus' || (key.length === 1 && SHIFTED_KEYS.includes(key))) {
    return [...withoutShift, key].join('+');
  }
  return hotkey;
}

type ShortcutSearchProps = {
  query: string;
  onQueryChange: (query: string) => void;
  isRecording: boolean;
  onRecordingChange: (on: boolean) => void;
};

/** Text search, or press a combination to find what it's bound to. */
export function ShortcutSearch({
  query,
  onQueryChange,
  isRecording,
  onRecordingChange,
}: ShortcutSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const rafRef = useRef(0);
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const stopRecording = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    onRecordingChange(false);
    inputRef.current?.focus();
  }, [onRecordingChange]);

  const { currentDisplay } = useHotkeyRecorder({
    isRecording,
    onRecord: (hotkey) => {
      onQueryChange(normalizeSearchRecording(hotkey));
      // Re-arm the recorder so the next combination can be pressed straight away.
      onRecordingChange(false);
      rafRef.current = requestAnimationFrame(() => onRecordingChange(true));
    },
    onCancel: stopRecording,
  });

  const recordLabel = isRecording ? 'Stop searching by keys' : 'Search by pressing a shortcut';

  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      {isRecording ? (
        <output
          aria-live="polite"
          className="flex h-9 w-full items-center rounded-[var(--field-radius)] border border-primary bg-field pl-9 text-sm ring-2 ring-primary/25"
        >
          {currentDisplay || (query ? hotkeyToDisplay(query) : null) || (
            <span className="text-muted-foreground">Press a key combination…</span>
          )}
        </output>
      ) : (
        <Input
          ref={inputRef}
          size="md"
          aria-label="Search shortcuts"
          placeholder="Search shortcuts"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          className="pl-9 pr-16"
        />
      )}
      <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
        {query && !isRecording && (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Clear search"
            onClick={() => onQueryChange('')}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          title={recordLabel}
          aria-label={recordLabel}
          aria-pressed={isRecording}
          onClick={() => {
            if (isRecording) return stopRecording();
            onRecordingChange(true);
          }}
          className={cn(isRecording && 'bg-primary/15 text-primary')}
        >
          <Keyboard className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
