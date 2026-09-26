/**
 * Viewport coordinates for the caret in a `<textarea>` at `index` (for `position: fixed` UI).
 * Mirror + span layout follows https://github.com/component/textarea-caret-position (MIT),
 * then maps to viewport using the textarea’s bounding rect and scroll offsets.
 */

import { TEXTAREA_MIRROR_STYLE_KEYS } from './textarea-mirror-style-keys';

export function getTextareaCaretViewportPosition(
  textarea: HTMLTextAreaElement,
  index: number,
): { top: number; left: number } {
  const value = textarea.value;
  const position = Math.max(0, Math.min(index, value.length));

  const mirror = document.createElement('div');
  try {
    document.body.appendChild(mirror);
    const ms = mirror.style;
    const computed = getComputedStyle(textarea);

    ms.whiteSpace = 'pre-wrap';
    ms.wordWrap = 'break-word';
    ms.position = 'absolute';
    ms.visibility = 'hidden';
    ms.left = '-9999px';
    ms.top = '0';

    for (const key of TEXTAREA_MIRROR_STYLE_KEYS) {
      const v = computed[key];
      if (typeof v === 'string' && v.length > 0) {
        (ms as unknown as Record<string, string>)[key] = v;
      }
    }

    const isFirefox =
      typeof window !== 'undefined' &&
      (window as Window & { mozInnerScreenX?: number }).mozInnerScreenX != null;
    if (isFirefox && textarea.scrollHeight > Number.parseInt(computed.height, 10)) {
      ms.overflowY = 'scroll';
    } else {
      ms.overflow = 'hidden';
    }

    mirror.textContent = value.slice(0, position);
    const span = document.createElement('span');
    span.textContent = value.slice(position) || '.';
    mirror.appendChild(span);

    const borderTop = Number.parseInt(computed.borderTopWidth, 10) || 0;
    const borderLeft = Number.parseInt(computed.borderLeftWidth, 10) || 0;
    const topInTextarea = span.offsetTop + borderTop;
    const leftInTextarea = span.offsetLeft + borderLeft;

    const rect = textarea.getBoundingClientRect();
    return {
      top: rect.top + topInTextarea - textarea.scrollTop,
      left: rect.left + leftInTextarea - textarea.scrollLeft,
    };
  } finally {
    if (mirror.parentNode === document.body) {
      document.body.removeChild(mirror);
    }
  }
}
