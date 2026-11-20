import { type RefObject, useCallback, useEffect, useRef } from 'react';
import { measureSlot, type SlotBlock, type SlotMeasureOptions } from './geometry';
import {
  isCoveredByLayers,
  mutationTouchesOccluder,
  type OccludingLayers,
  scanOccludingLayers,
} from './occlusion';
import type { ViewRect } from '../../../shared/types/browser';

/** `covered`: an overlay sits over the slot, so the view should give way to a still. */
export type NativeViewSlotState =
  | { bounds: ViewRect; covered: false; block: null }
  | { bounds: null; covered: boolean; block: SlotBlock | null };

export type NativeViewSlotOptions = SlotMeasureOptions & {
  /** Off: nothing is observed and `onChange` is not called. */
  enabled: boolean;
  /** DOM changes inside this element never move the slot, e.g. the view's own card. */
  ignoreWithin?: RefObject<HTMLElement | null>;
};

const OBSERVED_ATTRIBUTES = [
  'role',
  'aria-modal',
  'aria-hidden',
  'data-state',
  'data-native-view-occluder',
  'open',
  'hidden',
  'class',
  'style',
];

function readNativeViewSlot(
  element: HTMLElement | null,
  layers: OccludingLayers,
  options: SlotMeasureOptions,
): NativeViewSlotState {
  if (!element) return { bounds: null, covered: false, block: null };
  if (isCoveredByLayers(element, layers)) return { bounds: null, covered: true, block: null };
  const measurement = measureSlot(element, options);
  return measurement.bounds
    ? { bounds: measurement.bounds, covered: false, block: null }
    : { bounds: null, covered: false, block: measurement.block };
}

type NativeViewSlot = { read: () => NativeViewSlotState };

/** Reports where a native view may be drawn over `slotRef`, at most once per frame, on layout,
 * scroll and overlay changes; a new `onChange` identity re-reports with a fresh overlay scan. */
export function useNativeViewSlot(
  slotRef: RefObject<HTMLElement | null>,
  onChange: (slot: NativeViewSlotState) => void,
  options: NativeViewSlotOptions,
): NativeViewSlot {
  const { enabled, ignoreWithin, minWidth, minHeight, clip } = options;
  const layersRef = useRef<OccludingLayers>({ all: [], global: [], intersecting: [] });
  const frameRef = useRef<number | null>(null);
  const scanRef = useRef(false);

  const read = useCallback(() => {
    layersRef.current = scanOccludingLayers();
    return readNativeViewSlot(slotRef.current, layersRef.current, { minWidth, minHeight, clip });
  }, [clip, minHeight, minWidth, slotRef]);

  const schedule = useCallback(
    (scanLayers: boolean) => {
      scanRef.current ||= scanLayers;
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        if (scanRef.current) layersRef.current = scanOccludingLayers();
        scanRef.current = false;
        onChange(
          readNativeViewSlot(slotRef.current, layersRef.current, { minWidth, minHeight, clip }),
        );
      });
    },
    [clip, minHeight, minWidth, onChange, slotRef],
  );

  useEffect(() => {
    if (!enabled) return;
    const observer = new MutationObserver((records) => {
      const owner = ignoreWithin?.current;
      if (owner && records.every((record) => owner.contains(record.target))) return;
      schedule(records.some((record) => mutationTouchesOccluder(record, layersRef.current)));
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRIBUTES,
    });
    schedule(true);
    return () => {
      observer.disconnect();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      // A cancelled frame never resets the coalescer guard, which would wedge every later report.
      frameRef.current = null;
    };
  }, [enabled, ignoreWithin, schedule]);

  useEffect(() => {
    const element = slotRef.current;
    if (!enabled || !element) return;
    const update = (): void => schedule(false);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    const chatContent = element.closest('[data-chat-container]')?.firstElementChild;
    if (clip === 'chat-scrollport' && chatContent instanceof HTMLElement) {
      observer.observe(chatContent);
    }
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, [clip, enabled, schedule, slotRef]);

  return { read };
}
