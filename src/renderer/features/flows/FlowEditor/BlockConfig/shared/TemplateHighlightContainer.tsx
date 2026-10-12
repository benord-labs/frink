/* eslint-disable max-lines, max-lines-per-function */
/**
 * Mirror/overlay highlighting for `{{...}}` in template textareas.
 * Wraps an existing `<Textarea>` child (ref + keyboard handlers preserved).
 */

import {
  Children,
  cloneElement,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { NodeVariables } from '../../../../../../shared/lib/validate-flow-templates';
import { cn } from '../../../../../lib/utils';
import {
  classifyTemplatePath,
  extractTemplateRanges,
  type TemplateVarTone,
  warningMessageForPlaceholder,
} from './classify-template-placeholder';
import { TEXTAREA_MIRROR_STYLE_KEYS } from './textarea-mirror-style-keys';

/** Tied to the `globals.css` `flow-template-var-mark--*` utilities. */
const TONE_MARK_CLASS: Record<TemplateVarTone, string> = {
  valid: 'flow-template-var-mark--valid',
  dynamic: 'flow-template-var-mark--dynamic',
  undeclared: 'flow-template-var-mark--undeclared',
};

function mergeRefs<T>(...refs: Array<React.Ref<T> | undefined>): (instance: T | null) => void {
  return (instance: T | null) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(instance);
      else if (ref && typeof ref === 'object' && 'current' in ref) {
        (ref as React.MutableRefObject<T | null>).current = instance;
      }
    }
  };
}

type Props = {
  value: string;
  nodeVariables?: NodeVariables | null;
  customNodesLoading?: boolean;
  predecessorIsCustomNode?: boolean;
  /** When used inside {@link FieldRow}, the row passes this so the label associates with the textarea. */
  textareaId?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
  children: ReactElement;
};

export function TemplateHighlightContainer({
  value,
  nodeVariables,
  customNodesLoading = false,
  predecessorIsCustomNode = false,
  textareaId,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
  children,
}: Props): ReactNode {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollPollRef = useRef<number | null>(null);
  const scrollIdleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [composing, setComposing] = useState(false);

  const syncMirrorScrollOnly = useCallback(() => {
    const ta = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!ta || !mirror) return;
    mirror.scrollTop = ta.scrollTop;
    mirror.scrollLeft = ta.scrollLeft;
  }, []);

  const syncMirrorStyles = useCallback(() => {
    const ta = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!ta || !mirror) return;
    const computed = getComputedStyle(ta);
    const ms = mirror.style;
    ms.whiteSpace = 'pre-wrap';
    ms.wordWrap = 'break-word';
    ms.overflow = 'hidden';
    for (const key of TEXTAREA_MIRROR_STYLE_KEYS) {
      const v = computed[key];
      if (typeof v === 'string' && v.length > 0) {
        (ms as unknown as Record<string, string>)[key] = v;
      }
    }
    const isFirefox =
      typeof window !== 'undefined' &&
      (window as Window & { mozInnerScreenX?: number }).mozInnerScreenX != null;
    if (isFirefox && ta.scrollHeight > Number.parseInt(computed.height, 10)) {
      ms.overflowY = 'scroll';
    }
    mirror.scrollTop = ta.scrollTop;
    mirror.scrollLeft = ta.scrollLeft;
  }, []);

  useLayoutEffect(() => {
    syncMirrorStyles();
  }, [syncMirrorStyles]);

  useLayoutEffect(() => {
    syncMirrorScrollOnly();
  }, [value, syncMirrorScrollOnly]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const ro = new ResizeObserver(() => {
      syncMirrorStyles();
    });
    ro.observe(ta);
    return () => ro.disconnect();
  }, [syncMirrorStyles]);

  const stopScrollPoll = useCallback(() => {
    if (scrollPollRef.current != null) {
      cancelAnimationFrame(scrollPollRef.current);
      scrollPollRef.current = null;
    }
    if (scrollIdleRef.current != null) {
      clearTimeout(scrollIdleRef.current);
      scrollIdleRef.current = null;
    }
  }, []);

  const scheduleScrollPollEnd = useCallback(() => {
    if (scrollIdleRef.current != null) clearTimeout(scrollIdleRef.current);
    scrollIdleRef.current = setTimeout(() => {
      stopScrollPoll();
    }, 200);
  }, [stopScrollPoll]);

  useEffect(() => {
    return () => {
      stopScrollPoll();
    };
  }, [stopScrollPoll]);

  const onTextareaScroll = useCallback(() => {
    const ta = textareaRef.current;
    const mirror = mirrorRef.current;
    if (ta && mirror) {
      mirror.scrollTop = ta.scrollTop;
      mirror.scrollLeft = ta.scrollLeft;
    }
    if (scrollPollRef.current == null) {
      const tick = () => {
        const t = textareaRef.current;
        const m = mirrorRef.current;
        if (t && m) {
          m.scrollTop = t.scrollTop;
          m.scrollLeft = t.scrollLeft;
        }
        scrollPollRef.current = requestAnimationFrame(tick);
      };
      scrollPollRef.current = requestAnimationFrame(tick);
    }
    scheduleScrollPollEnd();
  }, [scheduleScrollPollEnd]);

  const child = Children.only(children) as ReactElement<
    React.TextareaHTMLAttributes<HTMLTextAreaElement>
  >;
  const childRef = (child as unknown as { ref?: React.Ref<HTMLTextAreaElement> }).ref;

  const mergedChild = cloneElement(
    child as ReactElement<Record<string, unknown>>,
    {
      id: textareaId ?? child.props.id,
      ref: mergeRefs(textareaRef, childRef),
      'aria-invalid': ariaInvalid ?? child.props['aria-invalid'],
      'aria-describedby':
        [ariaDescribedBy, child.props['aria-describedby']].filter(Boolean).join(' ') || undefined,
      // Grows with its text, so long templates read in full instead of scrolling a small box.
      className: cn(
        'relative z-10 bg-transparent caret-foreground field-sizing-content min-h-24 max-h-[60vh]',
        child.props.className,
      ),
      onScroll: (e: React.UIEvent<HTMLTextAreaElement>) => {
        onTextareaScroll();
        (child.props as React.TextareaHTMLAttributes<HTMLTextAreaElement>).onScroll?.(e);
      },
      onCompositionStart: (e: React.CompositionEvent<HTMLTextAreaElement>) => {
        setComposing(true);
        (child.props as React.TextareaHTMLAttributes<HTMLTextAreaElement>).onCompositionStart?.(e);
      },
      onCompositionEnd: (e: React.CompositionEvent<HTMLTextAreaElement>) => {
        setComposing(false);
        (child.props as React.TextareaHTMLAttributes<HTMLTextAreaElement>).onCompositionEnd?.(e);
      },
    } as Record<string, unknown>,
  );

  const ranges = composing ? [] : extractTemplateRanges(value);
  const classifyOpts = { customNodesLoading, predecessorIsCustomNode };
  const dynamicWarnings: string[] = [];
  const undeclaredWarnings: string[] = [];
  const seenDynamic = new Set<string>();
  const seenUndeclared = new Set<string>();
  for (const r of ranges) {
    const tone = classifyTemplatePath(r.path, nodeVariables ?? null, classifyOpts);
    if (tone === 'valid') continue;
    const msg = warningMessageForPlaceholder(r.path, tone, nodeVariables ?? null);
    if (!msg) continue;
    if (tone === 'dynamic') {
      if (!seenDynamic.has(msg)) {
        seenDynamic.add(msg);
        dynamicWarnings.push(msg);
      }
    } else if (!seenUndeclared.has(msg)) {
      seenUndeclared.add(msg);
      undeclaredWarnings.push(msg);
    }
  }

  const mirrorNodes: ReactNode[] = [];
  if (composing) {
    mirrorNodes.push(
      <span key="compose" className="text-transparent">
        {value}
      </span>,
    );
  } else {
    let cursor = 0;
    for (const r of ranges) {
      if (r.start > cursor) {
        mirrorNodes.push(
          <span key={`t-${cursor}`} className="text-transparent">
            {value.slice(cursor, r.start)}
          </span>,
        );
      }
      const tone = classifyTemplatePath(r.path, nodeVariables ?? null, classifyOpts);
      mirrorNodes.push(
        <mark key={`m-${r.start}`} className={TONE_MARK_CLASS[tone]}>
          {value.slice(r.start, r.end)}
        </mark>,
      );
      cursor = r.end;
    }
    if (cursor < value.length) {
      mirrorNodes.push(
        <span key={`t-${cursor}`} className="text-transparent">
          {value.slice(cursor)}
        </span>,
      );
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative w-full min-h-[80px]">
        <div
          ref={mirrorRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-lg text-sm leading-normal"
        >
          {mirrorNodes.length > 0 ? mirrorNodes : <span className="text-transparent">{value}</span>}
        </div>
        {mergedChild}
      </div>
      {dynamicWarnings.length > 0 || undeclaredWarnings.length > 0 ? (
        <ul className="space-y-1 text-xs">
          {dynamicWarnings.map((line) => (
            <li key={`d-${line}`} className="text-warning">
              {line}
            </li>
          ))}
          {undeclaredWarnings.map((line) => (
            <li key={`u-${line}`} className="flow-template-var-msg--undeclared">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

TemplateHighlightContainer.displayName = 'TemplateHighlightContainer';
