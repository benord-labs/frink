import { useCallback, useEffect, useRef, useState } from 'react';
import { keyToDisplay } from './shortcut-registry';

/**
 * Hook options for hotkey recording
 */
type UseHotkeyRecorderOptions = {
  /** Called when a valid hotkey combination is recorded */
  onRecord: (hotkey: string) => void;
  /** Called when recording is cancelled (e.g., Escape pressed) */
  onCancel: () => void;
  /** Whether recording is currently active */
  isRecording: boolean;
};

/**
 * Result of the hotkey recorder hook
 */
type UseHotkeyRecorderResult = {
  /** Currently pressed keys during recording */
  currentKeys: string[];
  /**
   * Current combination as a display string (e.g., "⌘⇧"). Uses the registry's Mac glyph
   * table, so it matches `hotkeyToDisplay` of the recorded hotkey.
   */
  currentDisplay: string;
  /** Ref to attach to the recording element */
  recorderRef: React.RefObject<HTMLDivElement | null>;
};

/**
 * Map of KeyboardEvent.key values to our internal key names
 */
const KEY_MAP: Record<string, string> = {
  // biome-ignore lint/style/useNamingConvention: KeyboardEvent.key values
  Meta: 'cmd',
  // biome-ignore lint/style/useNamingConvention: KeyboardEvent.key values
  Control: 'ctrl',
  // biome-ignore lint/style/useNamingConvention: KeyboardEvent.key values
  Alt: 'opt',
  // biome-ignore lint/style/useNamingConvention: KeyboardEvent.key values
  Shift: 'shift',
  // biome-ignore lint/style/useNamingConvention: KeyboardEvent.key values
  Escape: 'Esc',
  // biome-ignore lint/style/useNamingConvention: KeyboardEvent.key values
  Enter: 'Enter',
  // biome-ignore lint/style/useNamingConvention: KeyboardEvent.key values
  Backspace: 'Backspace',
  // biome-ignore lint/style/useNamingConvention: KeyboardEvent.key values
  Delete: 'Delete',
  // biome-ignore lint/style/useNamingConvention: KeyboardEvent.key values
  Tab: 'Tab',
  ' ': 'Space',
  // biome-ignore lint/style/useNamingConvention: KeyboardEvent.key values
  ArrowUp: '↑',
  // biome-ignore lint/style/useNamingConvention: KeyboardEvent.key values
  ArrowDown: '↓',
  // biome-ignore lint/style/useNamingConvention: KeyboardEvent.key values
  ArrowLeft: '←',
  // biome-ignore lint/style/useNamingConvention: KeyboardEvent.key values
  ArrowRight: '→',
  // The hotkey string format uses "+" as the separator, so "+" as a raw key
  // would break parsing: "cmd+shift++" splits to ["cmd","shift","",""].
  // Map both the unshifted ("=") and shifted ("+") forms of the same physical
  // key to the canonical name "plus" used by matchesHotkey.
  // "=" is included so that recording Cmd+= stores "cmd+plus" consistently
  // with the registry default rather than "cmd+=".
  '+': 'plus',
  '=': 'plus',
  // Minus: map to canonical "minus" so recorded bindings stay consistent with
  // registry defaults ("cmd+minus", not "cmd+-").
  '-': 'minus',
};

/**
 * Modifiers in display order
 */
const MODIFIER_ORDER = ['cmd', 'ctrl', 'opt', 'shift'];

/**
 * Check if a key is a modifier
 */
function isModifier(key: string): boolean {
  return MODIFIER_ORDER.includes(key);
}

/**
 * Convert KeyboardEvent to our internal key representation
 */
function eventKeyToInternal(e: KeyboardEvent): string {
  const mapped = KEY_MAP[e.key];
  if (mapped) return mapped;

  // For single characters, use uppercase
  if (e.key.length === 1) {
    return e.key.toUpperCase();
  }

  // For special keys like F1, F2, etc.
  return e.key;
}

/**
 * Build hotkey string from modifiers and key
 */
function buildHotkeyString(modifiers: Set<string>, key: string | null): string {
  const parts: string[] = [];

  // Add modifiers in order
  for (const mod of MODIFIER_ORDER) {
    if (modifiers.has(mod)) {
      parts.push(mod);
    }
  }

  // Add the main key
  if (key) {
    parts.push(key.toLowerCase());
  }

  return parts.join('+');
}

/** Build display string from modifiers (in MODIFIER_ORDER) and key. The registry's `keyToDisplay`
 * maps both the recorder's names (`Esc`, `Enter`, …) and its pre-mapped arrow glyphs. */
function buildDisplayString(modifiers: Set<string>, key: string | null): string {
  const parts: string[] = [];

  // Add modifiers in order
  for (const mod of MODIFIER_ORDER) {
    if (modifiers.has(mod)) {
      parts.push(keyToDisplay(mod));
    }
  }

  // Add the main key
  if (key) {
    parts.push(keyToDisplay(key));
  }

  return parts.join('');
}

/**
 * Hook for recording keyboard shortcuts
 *
 * Usage:
 * ```tsx
 * const { currentKeys, currentDisplay, recorderRef } = useHotkeyRecorder({
 *   onRecord: (hotkey) => console.log("Recorded:", hotkey),
 *   onCancel: () => console.log("Cancelled"),
 *   isRecording: true,
 * })
 * ```
 */
export function useHotkeyRecorder({
  onRecord,
  onCancel,
  isRecording,
}: UseHotkeyRecorderOptions): UseHotkeyRecorderResult {
  // Refs for recording logic — event handlers always see latest values
  // (React state closures go stale when multiple keys fire in the same tick)
  const modifiersRef = useRef<Set<string>>(new Set());
  const mainKeyRef = useRef<string | null>(null);
  const hasRecordedRef = useRef(false);

  // State for display only — synced from refs after each event
  const [displayModifiers, setDisplayModifiers] = useState<Set<string>>(new Set());
  const [displayMainKey, setDisplayMainKey] = useState<string | null>(null);

  const recorderRef = useRef<HTMLDivElement>(null);

  // Keep callback refs fresh to avoid stale closures in event handlers
  const onRecordRef = useRef(onRecord);
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onRecordRef.current = onRecord;
    onCancelRef.current = onCancel;
  }, [onRecord, onCancel]);

  // Sync refs to display state
  const syncDisplay = useCallback(() => {
    setDisplayModifiers(new Set(modifiersRef.current));
    setDisplayMainKey(mainKeyRef.current);
  }, []);

  // Reset state when recording starts (not when it stops, to avoid flicker)
  useEffect(() => {
    if (isRecording) {
      modifiersRef.current = new Set();
      mainKeyRef.current = null;
      hasRecordedRef.current = false;
      syncDisplay();
    }
  }, [isRecording, syncDisplay]);

  // Handle keydown
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isRecording) return;

      e.preventDefault();
      e.stopPropagation();

      const key = eventKeyToInternal(e);

      // Handle Escape to cancel (always cancels, even with modifiers held)
      if (key === 'Esc') {
        onCancelRef.current();
        return;
      }

      if (isModifier(key)) {
        modifiersRef.current = new Set([...modifiersRef.current, key]);
      } else {
        mainKeyRef.current = key;
      }
      syncDisplay();
    },
    [isRecording, syncDisplay],
  );

  // Handle keyup
  const handleKeyUp = useCallback(
    (e: KeyboardEvent) => {
      if (!isRecording) return;
      // Don't process keyup after recording - keep state frozen
      if (hasRecordedRef.current) return;

      const key = eventKeyToInternal(e);

      if (isModifier(key)) {
        // If we have a main key, record the combination before removing modifier
        if (mainKeyRef.current) {
          hasRecordedRef.current = true;
          const hotkey = buildHotkeyString(modifiersRef.current, mainKeyRef.current);
          onRecordRef.current(hotkey);
          // Don't remove modifier - keep display frozen
          return;
        }
        // No main key yet, remove modifier
        const next = new Set(modifiersRef.current);
        next.delete(key);
        modifiersRef.current = next;
      } else {
        // Main key released - record if we have modifiers or it's a valid single key
        const validSingleKeys = ['?', '/', 'Esc', 'Enter', 'Tab'];
        if (modifiersRef.current.size > 0 || validSingleKeys.includes(key)) {
          hasRecordedRef.current = true;
          const hotkey = buildHotkeyString(modifiersRef.current, key);
          onRecordRef.current(hotkey);
        }
      }
      syncDisplay();
    },
    [isRecording, syncDisplay],
  );

  // Attach event listeners
  useEffect(() => {
    if (!isRecording) return;

    // Use capture phase to intercept before other handlers
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
    };
  }, [isRecording, handleKeyDown, handleKeyUp]);

  // Build current keys array for display
  const currentKeys: string[] = [
    ...MODIFIER_ORDER.filter((mod) => displayModifiers.has(mod)),
    ...(displayMainKey ? [displayMainKey] : []),
  ];

  const currentDisplay = buildDisplayString(displayModifiers, displayMainKey);

  return {
    currentKeys,
    currentDisplay,
    recorderRef,
  };
}
