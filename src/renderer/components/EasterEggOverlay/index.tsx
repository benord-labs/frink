import { useAtomValue, useSetAtom } from 'jotai';
import {
  Component,
  lazy,
  memo,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  arcadeRunAtom,
  floatingBadgeActiveAtom,
  HELP_FRINK_SEQUENCE,
  isInputFocused,
  KONAMI_SEQUENCE,
  LATE_NIGHT_LINE,
  mascotCameoActiveAtom,
  mascotChaserActiveAtom,
  mascotWalkOnActiveAtom,
  useKeySequence,
  useLateNightCameo,
  useStartArcade,
} from '../../hooks/use-easter-eggs';
import { FloatingBadge } from '../FloatingBadge';
import { MascotWalkOn } from '../Mascot';
import { MascotCameo } from '../Mascot/MascotCameo';
import { MascotChaser } from '../Mascot/MascotChaser';

/** Konami-only, so it stays out of the main chunk until the code is entered. */
const FrinkArcade = lazy(() => import('./FrinkArcade').then((m) => ({ default: m.FrinkArcade })));

const KONAMI_KEY_GAP_MS = 5000;
const HELP_FRINK_KEY_GAP_MS = 6000;

// Reason: pre-existing debt; the rename re-keyed the finding, the body is unchanged.
// fallow-ignore-next-line complexity
export const EasterEggOverlay = memo(function EasterEggOverlay() {
  const arcadeRun = useAtomValue(arcadeRunAtom);
  const setArcadeRun = useSetAtom(arcadeRunAtom);
  const dvdActive = useAtomValue(floatingBadgeActiveAtom);
  const setDvdActive = useSetAtom(floatingBadgeActiveAtom);
  const pixelFrinkActive = useAtomValue(mascotWalkOnActiveAtom);
  const setMascotWalkOnActive = useSetAtom(mascotWalkOnActiveAtom);

  const startArcade = useStartArcade();
  const pixelFrinkActiveRef = useRef(pixelFrinkActive);
  pixelFrinkActiveRef.current = pixelFrinkActive;
  // HELPFRINK owns the keyboard while it runs, so Konami is ignored until it finishes.
  const onKonami = useCallback(() => {
    if (!pixelFrinkActiveRef.current) startArcade();
  }, [startArcade]);
  useKeySequence(KONAMI_SEQUENCE, onKonami, { timeoutMs: KONAMI_KEY_GAP_MS });
  const arcadeRunRef = useRef(arcadeRun);
  arcadeRunRef.current = arcadeRun;
  // Belt and braces: the game already swallows the keys, but HELPFRINK never starts over it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: setMascotWalkOnActive is a stable Jotai setter; empty deps keep the key listener registered once.
  const summonMascot = useCallback(() => {
    if (arcadeRunRef.current === null) setMascotWalkOnActive(true);
  }, []);
  useKeySequence(HELP_FRINK_SEQUENCE, summonMascot, {
    timeoutMs: HELP_FRINK_KEY_GAP_MS,
    shouldIgnore: isInputFocused,
  });
  const cameoActive = useAtomValue(mascotCameoActiveAtom);
  const setCameoActive = useSetAtom(mascotCameoActiveAtom);
  const enragedActive = useAtomValue(mascotChaserActiveAtom);
  // MascotChaser stays mounted after `enragedActive` drops so it can play its
  // walk-off; it unmounts when the component fires onExitComplete.
  const [enragedMounted, setEnragedMounted] = useState(false);
  const [enragedExiting, setEnragedExiting] = useState(false);
  const [lateNightActive, setLateNightActive] = useState(false);
  const frinkOnScreen =
    pixelFrinkActive || cameoActive || enragedActive || enragedMounted || lateNightActive;
  // The arcade counts too: its boss is a Frink, and a game shouldn't be walked over.
  const lateNightBlockedRef = useRef(frinkOnScreen);
  lateNightBlockedRef.current = frinkOnScreen || arcadeRun !== null;
  const showLateNight = useCallback(() => {
    if (lateNightBlockedRef.current) return false;
    setLateNightActive(true);
    return true;
  }, []);
  useLateNightCameo(showLateNight);
  const onLateNightComplete = useCallback(() => setLateNightActive(false), []);

  const onDismiss = useCallback(() => setDvdActive(false), [setDvdActive]);
  // Only the run that finished may clear the arcade; a newer run keeps playing.
  const onArcadeDone = useCallback(
    (run: number) => setArcadeRun((current) => (current === run ? null : current)),
    [setArcadeRun],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: setMascotWalkOnActive is a stable Jotai setter; empty deps keep MascotWalkOn onComplete stable.
  const onFrinkComplete = useCallback(() => {
    setMascotWalkOnActive(false);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: setCameoActive is a stable Jotai setter; empty deps keep MascotCameo onComplete stable across re-renders.
  const onCameoComplete = useCallback(() => {
    setCameoActive(false);
  }, []);

  // Mount while active, walk off while exiting, unmount after complete — otherwise
  // the chaser vanishes mid-pursuit the moment the click decay fires.
  useEffect(() => {
    if (enragedActive) {
      setEnragedMounted(true);
      setEnragedExiting(false);
    } else if (enragedMounted) {
      setEnragedExiting(true);
    }
  }, [enragedActive, enragedMounted]);

  const onEnragedExitComplete = useCallback(() => {
    setEnragedMounted(false);
    setEnragedExiting(false);
  }, []);

  // Cancel any in-flight cameo as soon as enraged starts. Otherwise rapid
  // clicks 15 → 30 leave both Frinks on screen at once and it looks chaotic.
  useEffect(() => {
    if (enragedActive && cameoActive) {
      setCameoActive(false);
    }
    if (enragedActive) setLateNightActive(false);
  }, [enragedActive, cameoActive, setCameoActive]);

  /** Stable identity for error-boundary recovery — do not use `children` referential equality (new elements every render). */
  const recoveryKey = useMemo(() => {
    const arcadePart = arcadeRun ?? '';
    return [
      arcadePart,
      dvdActive,
      pixelFrinkActive,
      cameoActive,
      enragedMounted,
      lateNightActive,
    ].join('|');
  }, [arcadeRun, dvdActive, pixelFrinkActive, cameoActive, enragedMounted, lateNightActive]);

  return (
    <EasterEggBoundary recoveryKey={recoveryKey}>
      {arcadeRun && (
        <Suspense fallback={null}>
          <FrinkArcade key={arcadeRun} run={arcadeRun} onDone={onArcadeDone} />
        </Suspense>
      )}
      {dvdActive && <FloatingBadge onDismiss={onDismiss} />}
      {pixelFrinkActive && <MascotWalkOn onComplete={onFrinkComplete} />}
      {cameoActive && <MascotCameo onComplete={onCameoComplete} />}
      {lateNightActive && <MascotCameo line={LATE_NIGHT_LINE} onComplete={onLateNightComplete} />}
      {enragedMounted && (
        <MascotChaser isExiting={enragedExiting} onExitComplete={onEnragedExitComplete} />
      )}
    </EasterEggBoundary>
  );
});

/**
 * Eggs are decorative: a throw inside one is logged and swallowed, never surfaced.
 */
export class EasterEggBoundary extends Component<
  { children: ReactNode; recoveryKey: string },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    // biome-ignore lint/suspicious/noConsole: easter-egg failures should be visible in dev / sentry, not crash the app.
    console.warn('[easter-eggs] boundary caught', error);
  }

  componentDidUpdate(prevProps: { children: ReactNode; recoveryKey: string }) {
    if (this.state.hasError && prevProps.recoveryKey !== this.props.recoveryKey) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}
