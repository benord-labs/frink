import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type {
  ArtifactPreviewBounds,
  HtmlArtifactData,
} from '../../../../shared/types/artifacts/html-artifact';
import { measureSlot } from './geometry';
import {
  isCoveredByLayers,
  mutationTouchesOccluder,
  type OccludingLayers,
  scanOccludingLayers,
} from './occlusion';

type GuestRuntime = {
  generation: number;
  hasOpenError: boolean;
  isOpen: boolean;
  isOpening: boolean;
};
type GuestViewState = { error: string | null; isOpening: boolean; isReady: boolean };
type ResolvedPresentation =
  | { artifact: HtmlArtifactData; bounds: ArtifactPreviewBounds; pauseReason: null }
  | { artifact: null; bounds: null; pauseReason: string | null };

async function closeGuestIfActive(runtime: GuestRuntime, close: () => Promise<void>) {
  if (runtime.isOpen || runtime.isOpening) await close();
}

async function syncGuestPresentation(
  surfaceId: string,
  runtime: GuestRuntime,
  presentation: Extract<ResolvedPresentation, { artifact: HtmlArtifactData }>,
  open: (artifact: HtmlArtifactData, bounds: ArtifactPreviewBounds) => Promise<void>,
) {
  if (runtime.isOpen) {
    await window.desktopApi.artifactPreview.updateBounds({
      surfaceId,
      bounds: presentation.bounds,
    });
  } else if (!runtime.isOpening) {
    await open(presentation.artifact, presentation.bounds);
  }
}

function resolvePresentation(
  selection: HtmlArtifactData | null,
  isHostAvailable: boolean,
  element: HTMLElement | null,
  layers: OccludingLayers,
): ResolvedPresentation {
  if (!selection) return { artifact: null, bounds: null, pauseReason: null };
  if (!isHostAvailable) {
    return { artifact: null, bounds: null, pauseReason: 'Interactive result paused.' };
  }
  if (isCoveredByLayers(element, layers)) {
    return {
      artifact: null,
      bounds: null,
      pauseReason: 'Interactive result paused while another control is open.',
    };
  }
  if (!element) return { artifact: null, bounds: null, pauseReason: null };
  const measurement = measureSlot(element);
  if (!measurement.bounds) return { artifact: null, ...measurement };
  return { artifact: selection, ...measurement };
}

function useHostAvailability(isPaneActive: boolean) {
  const [isWindowFocused, setIsWindowFocused] = useState<boolean | null>(null);
  const [isDocumentVisible, setIsDocumentVisible] = useState(
    () => document.visibilityState === 'visible',
  );

  useEffect(() => {
    let receivedFocusEvent = false;
    let active = true;
    const removeFocusListener = window.desktopApi.onFocusChange((isFocused) => {
      receivedFocusEvent = true;
      setIsWindowFocused(isFocused);
    });
    void window.desktopApi.artifactPreview
      .isHostFocused()
      .then((isFocused) => {
        if (active && !receivedFocusEvent) setIsWindowFocused(isFocused);
      })
      .catch(() => {
        if (active && !receivedFocusEvent) setIsWindowFocused(false);
      });
    const updateVisibility = (): void =>
      setIsDocumentVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', updateVisibility);
    return () => {
      active = false;
      removeFocusListener();
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  }, []);

  return {
    isAvailable:
      isWindowFocused === null ? null : isPaneActive && isWindowFocused && isDocumentVisible,
  };
}

function useGuestLifecycle(surfaceId: string) {
  const runtimeRef = useRef<GuestRuntime>({
    generation: 0,
    hasOpenError: false,
    isOpen: false,
    isOpening: false,
  });
  const [view, setView] = useState<GuestViewState>({
    error: null,
    isOpening: false,
    isReady: false,
  });

  const close = useCallback(async () => {
    const runtime = runtimeRef.current;
    runtime.generation += 1;
    setView((current) =>
      current.isReady || current.isOpening
        ? { ...current, isOpening: false, isReady: false }
        : current,
    );
    if (!runtime.isOpen && !runtime.isOpening) return;
    runtime.isOpen = false;
    runtime.isOpening = false;
    await window.desktopApi.artifactPreview.close({ surfaceId }).catch(() => undefined);
  }, [surfaceId]);

  const open = useCallback(
    async (artifact: HtmlArtifactData, bounds: ArtifactPreviewBounds) => {
      const runtime = runtimeRef.current;
      const generation = runtime.generation + 1;
      runtime.generation = generation;
      runtime.isOpening = true;
      setView({ error: null, isOpening: true, isReady: false });
      try {
        await window.desktopApi.artifactPreview.open({ surfaceId, artifact, bounds });
        if (generation !== runtime.generation) return;
        runtime.isOpen = true;
        setView({ error: null, isOpening: false, isReady: true });
      } catch {
        if (generation === runtime.generation) {
          runtime.hasOpenError = true;
          setView({
            error: 'Interactive result could not be opened.',
            isOpening: false,
            isReady: false,
          });
        }
      } finally {
        if (generation === runtime.generation) runtime.isOpening = false;
      }
    },
    [surfaceId],
  );

  const invalidate = useCallback(() => {
    const runtime = runtimeRef.current;
    runtime.generation += 1;
    runtime.isOpen = false;
    runtime.isOpening = false;
    setView((current) => ({ ...current, isOpening: false, isReady: false }));
  }, []);
  const fail = useCallback(
    (message: string) => {
      runtimeRef.current.hasOpenError = true;
      invalidate();
      setView({ error: message, isOpening: false, isReady: false });
    },
    [invalidate],
  );
  const resetError = useCallback(() => {
    runtimeRef.current.hasOpenError = false;
    setView((current) => (current.error ? { ...current, error: null } : current));
  }, []);
  const focus = useCallback(
    () => window.desktopApi.artifactPreview.focus({ surfaceId }),
    [surfaceId],
  );

  return { close, fail, focus, invalidate, open, resetError, runtimeRef, view };
}

function usePreviewPresentation(
  surfaceId: string,
  selection: HtmlArtifactData | null,
  isHostAvailable: boolean | null,
  surfaceRef: RefObject<HTMLElement | null>,
  placeholderRef: RefObject<HTMLDivElement | null>,
  guest: ReturnType<typeof useGuestLifecycle>,
) {
  const [pauseReason, setPauseReason] = useState<string | null>(null);
  const pausedRef = useRef(false);
  const layersRef = useRef<OccludingLayers>({ all: [], global: [], intersecting: [] });
  const frameRef = useRef<number | null>(null);
  const scanRef = useRef(false);

  const present = useCallback(
    async (scanLayers: boolean, allowOpen = false) => {
      const runtime = guest.runtimeRef.current;
      if (runtime.hasOpenError) return;
      if (isHostAvailable === null) return;
      const element = placeholderRef.current;
      if (scanLayers) layersRef.current = scanOccludingLayers();
      const presentation = resolvePresentation(
        selection,
        isHostAvailable,
        element,
        layersRef.current,
      );
      if (!presentation.bounds) {
        if (presentation.pauseReason) {
          pausedRef.current = true;
          setPauseReason(presentation.pauseReason);
        }
        await closeGuestIfActive(runtime, guest.close);
        return;
      }
      if (pausedRef.current && !allowOpen) return;
      pausedRef.current = false;
      setPauseReason(null);
      await syncGuestPresentation(surfaceId, runtime, presentation, guest.open);
    },
    [
      guest.close,
      guest.open,
      guest.runtimeRef,
      isHostAvailable,
      placeholderRef,
      selection,
      surfaceId,
    ],
  );

  const schedulePresent = useCallback(
    (scanLayers: boolean) => {
      scanRef.current ||= scanLayers;
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        const shouldScan = scanRef.current;
        scanRef.current = false;
        void present(shouldScan);
      });
    },
    [present],
  );

  useEffect(() => {
    const observer = new MutationObserver((records) => {
      if (records.every((record) => surfaceRef.current?.contains(record.target))) return;
      schedulePresent(records.some((record) => mutationTouchesOccluder(record, layersRef.current)));
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'role',
        'aria-modal',
        'aria-hidden',
        'data-state',
        'data-artifact-preview-occluder',
        'open',
        'hidden',
        'class',
        'style',
      ],
    });
    surfaceRef.current?.scrollIntoView({ block: 'nearest' });
    schedulePresent(true);
    return () => {
      observer.disconnect();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      // Clearing the handle reopens the coalescer guard: a cancelled frame never
      // runs the callback that would otherwise reset it, wedging every later present().
      frameRef.current = null;
    };
  }, [schedulePresent, surfaceRef]);

  useEffect(() => {
    const element = placeholderRef.current;
    if (!element || !selection) return;
    const update = (): void => schedulePresent(false);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    const chatContent = element.closest('[data-chat-container]')?.firstElementChild;
    if (chatContent instanceof HTMLElement) observer.observe(chatContent);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
      void guest.close();
    };
  }, [guest.close, placeholderRef, schedulePresent, selection]);

  const resume = useCallback(async () => {
    guest.resetError();
    pausedRef.current = false;
    setPauseReason(null);
    await present(true, true);
  }, [guest.resetError, present]);
  const markPaused = useCallback((reason: string) => {
    pausedRef.current = true;
    setPauseReason(reason);
  }, []);
  return { markPaused, pauseReason, resume };
}

function useNativeEvents(
  surfaceId: string,
  closeArtifact: () => void,
  guest: ReturnType<typeof useGuestLifecycle>,
  markPaused: (reason: string) => void,
  interactRef: RefObject<HTMLButtonElement | null>,
  recoveryRef: RefObject<HTMLButtonElement | null>,
): void {
  useEffect(
    () =>
      window.desktopApi.artifactPreview.onClosed((event) => {
        if (event.surfaceId !== surfaceId) return;
        guest.invalidate();
        if (event.reason === 'suspended') {
          markPaused('Interactive result paused.');
        } else if (event.reason === 'failed') {
          guest.fail('Interactive result stopped responding.');
        } else {
          closeArtifact();
        }
        queueMicrotask(() => recoveryRef.current?.focus());
      }),
    [closeArtifact, guest.fail, guest.invalidate, markPaused, recoveryRef, surfaceId],
  );
  useEffect(
    () =>
      window.desktopApi.artifactPreview.onFocusReturned((event) => {
        if (event.surfaceId === surfaceId) interactRef.current?.focus();
      }),
    [interactRef, surfaceId],
  );
}

export function useHtmlArtifactPreview(
  surfaceId: string,
  selection: HtmlArtifactData | null,
  isPaneActive: boolean,
  closeArtifact: () => void,
) {
  const surfaceRef = useRef<HTMLElement | null>(null);
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const interactRef = useRef<HTMLButtonElement | null>(null);
  const recoveryRef = useRef<HTMLButtonElement | null>(null);
  const host = useHostAvailability(isPaneActive);
  const guest = useGuestLifecycle(surfaceId);
  const presentation = usePreviewPresentation(
    surfaceId,
    selection,
    host.isAvailable,
    surfaceRef,
    placeholderRef,
    guest,
  );
  useNativeEvents(
    surfaceId,
    closeArtifact,
    guest,
    presentation.markPaused,
    interactRef,
    recoveryRef,
  );

  const reload = useCallback(async () => {
    guest.resetError();
    await guest.close();
    await presentation.resume();
  }, [guest.close, guest.resetError, presentation.resume]);

  return {
    error: guest.view.error,
    focus: guest.focus,
    interactRef,
    isOpening: guest.view.isOpening,
    isReady: guest.view.isReady,
    pauseReason: presentation.pauseReason,
    placeholderRef,
    recoveryRef,
    reload,
    resume: presentation.resume,
    surfaceRef,
  };
}
