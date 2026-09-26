import { type ChangeEvent, useEffect, useEffectEvent, useRef, useState } from 'react';
import { holdThemeSwitching } from '../paint-theme';

// A drag back to its start value fires no `change`, so pointerup releases too.
const RELEASE_EVENTS = ['change', 'pointerup'] as const;

/** Previews a range input at most once a frame while it moves; release commits and repaints it,
 * since a drag back to the start leaves the atom unchanged. Transitions stay off for that frame. */
export function useLiveValue(
  committed: number,
  preview: (value: number) => void,
  commit: (value: number) => void,
  disabled = false,
) {
  const [draft, setDraft] = useState<number | null>(null);
  const frame = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const release = useEffectEvent((value: number) => {
    cancelAnimationFrame(frame.current);
    holdThemeSwitching();
    preview(value);
    setDraft(null);
    commit(value);
  });

  // No release came (unmounted, or disabled mid-drag): repaint the stored value over the preview.
  const abandon = useEffectEvent(() => {
    cancelAnimationFrame(frame.current);
    if (draft === null) return;
    preview(committed);
    setDraft(null);
  });

  useEffect(() => {
    const input = inputRef.current;
    if (!input || disabled) return;
    const onRelease = () => release(Number(input.value));
    for (const type of RELEASE_EVENTS) input.addEventListener(type, onRelease);
    return () => {
      for (const type of RELEASE_EVENTS) input.removeEventListener(type, onRelease);
      abandon();
    };
  }, [disabled]);

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.currentTarget.value);
    holdThemeSwitching();
    setDraft(value);
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => preview(value));
  };

  return { value: draft ?? committed, inputRef, onChange };
}
