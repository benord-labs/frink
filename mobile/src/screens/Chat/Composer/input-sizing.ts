import type { TextStyle } from 'react-native';

/** One line of message text, before Dynamic Type scaling. */
export const LINE = 22;
/** Lines the message box grows to before it scrolls. */
export const MAX_LINES = 6;

type Sizing = { style: TextStyle; scrollEnabled: boolean; measure: boolean };

/**
 * How the message box sizes itself.
 *
 * On a phone the text view grows with its content between one line and MAX_LINES, then scrolls,
 * like any chat box. Nothing is measured or fixed by hand: pinning the height to a count derived
 * from `onContentSizeChange`, turning scrolling off below the cap and setting `lineHeight` made
 * iOS clip the text with no way to scroll back to the first line.
 *
 * A web textarea never grows or reports a shrinking size, so the web preview alone keeps the
 * measured height: a fixed number of lines, scrolling only past the cap.
 */
export function messageInputSizing(
  web: boolean,
  line: number,
  contentHeight: number,
  hasText: boolean,
): Sizing {
  if (!web)
    return {
      style: { minHeight: line, maxHeight: line * MAX_LINES, textAlignVertical: 'top' },
      scrollEnabled: true,
      measure: false,
    };
  // A cleared draft collapses at once; web textareas never report a shrinking scroll height.
  const lines = hasText ? Math.max(1, Math.round(contentHeight / line)) : 1;
  return {
    style: { height: Math.min(lines, MAX_LINES) * line, lineHeight: LINE },
    scrollEnabled: lines > MAX_LINES,
    measure: true,
  };
}
