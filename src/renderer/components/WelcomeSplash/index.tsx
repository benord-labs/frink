import { Button } from '@benord-labs/frink-primitives';
import { motion } from 'motion/react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { lazy, memo, Suspense, useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '@/hooks/use-prefers-reduced-motion';
import { BUTTON_SHADOW } from '@/lib/button-shadow';
import { cn } from '@/lib/utils';
import { hasWebGl } from '@/lib/webgl/has-webgl';
import { TextShimmer } from '../ui/text-shimmer';

const FrinkScene = lazy(() => import('./FrinkScene').then((m) => ({ default: m.FrinkScene })));

const STORAGE_KEY = 'frink:has-seen-welcome';

// Pin the trace + glow to the same violet as the 3D mark so the trace→3D handoff
// keeps one colour in both themes (the --primary token would flip the trace blue
// in the light theme while the solid mark stays violet).
const MARK_VIOLET = '#7c5cff';

// Hold the swap until the SVG outline has visibly drawn itself (ms), then hand to the 3D mark. The
// 3D enters FRONT-ON (rotation [0,0,0]) with its EDGES already lit — the same violet line the trace
// drew — registered to the same footprint. So the opacity swap lands on a coincident outline (the
// drawn line becoming the 3D edges in place); the body then FILLS and the tilt + idle tumble ease in
// INSIDE the scene, after the swap, never as a crossfade between two misaligned images.
const TRACE_SETTLE_MS = 2200;

// The two Frink mark paths — stroked for the instant trace fallback before 3D mounts.
const MARK_PATHS = [
  'M350.3 166.97L244.64 229.85C237.67 234 233.44 241.34 233.46 249.24C233.59 291.18 233.7 333.12 233.84 375.04L149.69 426.42V219.37C149.69 204.69 157.5 191.03 170.37 183.19L350.3 73.59V166.97Z',
  'M350.3 199.41V285.79L260.18 340.79V263.8C260.18 257.46 263.57 251.57 269.15 248.22L350.3 199.41Z',
];

// Instant, dependency-free mark. Animated: draws the outline only (no fill), then the 3D mark
// takes over edge-first in the same violet line. Non-animated (reduced motion / no WebGL): the
// solid filled mark is the permanent image.
function MarkTrace({ animate }: { animate: boolean }) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative — the hero is aria-hidden
    <svg
      aria-hidden
      viewBox="0 0 500 500"
      className="h-full w-full"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {MARK_PATHS.map((d, index) =>
        animate ? (
          <motion.path
            key={d}
            d={d}
            stroke={MARK_VIOLET}
            strokeWidth={6}
            strokeLinejoin="round"
            fill="none"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{
              pathLength: { duration: 2.2, ease: [0.16, 1, 0.3, 1], delay: index * 0.18 },
            }}
          />
        ) : (
          <path key={d} d={d} fill={MARK_VIOLET} />
        ),
      )}
    </svg>
  );
}

export const WelcomeSplash = memo(function WelcomeSplash() {
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const seen = localStorage.getItem(STORAGE_KEY) === 'true';
    if (!seen) setVisible(true);
  }, []);

  // The splash is a modal overlay: move focus onto the dialog itself when it opens (so a screen
  // reader announces the dialog before the action, rather than landing straight on the button).
  // Enter/Escape/Tab are handled below, so the keyboard never falls through to the (obscured) app
  // behind — which is what broke keyboard access.
  useEffect(() => {
    if (visible) overlayRef.current?.focus();
  }, [visible]);

  if (!visible) return null;

  const dismiss = () => {
    setExiting(true);
    localStorage.setItem(STORAGE_KEY, 'true');
    // Outlast the 300ms exit fade so the overlay is fully transparent before it unmounts.
    window.setTimeout(() => setVisible(false), 300);
  };

  // Enter/Escape dismiss; Tab is trapped on the sole CTA so focus stays inside the dialog.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === 'Escape') {
      event.preventDefault();
      dismiss();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      overlayRef.current?.querySelector('button')?.focus();
    }
  };

  return (
    <div
      ref={overlayRef}
      data-agents-page
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Frink"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={cn(
        'fixed inset-0 z-1000 bg-background outline-hidden',
        'transition-opacity duration-300 ease-out',
        exiting ? 'opacity-0' : 'opacity-100',
      )}
      style={
        {
          '--chat-atmosphere-primary-stop': '0.09',
          '--chat-atmosphere-depth-stop': '0.025',
          '--chat-atmosphere-head-wash': '0.05',
        } as CSSProperties
      }
    >
      <div
        aria-hidden
        className="chat-canvas-atmosphere pointer-events-none absolute inset-0 z-0 overflow-hidden"
      />

      <div className="relative z-10 flex h-full w-full items-center justify-center">
        <WelcomeHero exiting={exiting} onDismiss={dismiss} />
      </div>
    </div>
  );
});

function WelcomeHero({ exiting, onDismiss }: { exiting: boolean; onDismiss: () => void }) {
  const reducedMotion = usePrefersReducedMotion();
  const [sceneReady, setSceneReady] = useState(false);
  const [traceSettled, setTraceSettled] = useState(false);
  const [webglOk] = useState(hasWebGl);

  // Reduced motion OR no WebGL → never mount the Canvas; the stroked mark is the final image.
  const allow3d = !reducedMotion && webglOk;
  // Swap off the SVG trace only once the 3D scene is live AND the outline has drawn. The 3D mark is
  // front-on (rotation [0,0,0]) with its edges lit and registered to the same footprint, so this is
  // the drawn outline becoming the 3D edges in place; the body-fill + tilt + idle tumble then ease
  // in INSIDE the scene (gated by this same flag), after the swap.
  const showRich = allow3d && sceneReady && traceSettled;

  useEffect(() => {
    if (!allow3d) return;
    const timer = window.setTimeout(() => setTraceSettled(true), TRACE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [allow3d]);

  return (
    <div
      className={cn(
        'grid h-full w-full grid-rows-[1fr_auto_1fr] px-8 text-center',
        'transition-all duration-300 ease-out',
        exiting ? 'translate-y-2 opacity-0' : 'translate-y-0 opacity-100',
      )}
    >
      {/* Mark — sits just above the viewport-centred headline (content arranged around the centre). */}
      <div className="flex items-end justify-center pb-2">
        <div
          aria-hidden
          className="relative h-[160px] w-[160px]"
          // Violet (not --primary) so the soft glow stays in the mark's hue and never
          // becomes a harsh blue halo under the light theme; low alpha reads on both.
          style={{ filter: 'drop-shadow(0 16px 44px rgb(124 92 255 / 0.16))' }}
        >
          {/* 2D trace layer — the instant mark; fades out fast onto the front-on, edge-lit 3D
              outline (same violet line, same place — no double image), and stays as the only mark
              when motion is reduced or WebGL is unavailable. */}
          <div
            className={cn(
              'absolute inset-0 transition-opacity duration-500 ease-out',
              showRich ? 'opacity-0' : 'opacity-100',
            )}
          >
            <MarkTrace animate={allow3d} />
          </div>
          {allow3d && (
            <Suspense fallback={null}>
              <div
                className={cn(
                  'absolute inset-0 transition-opacity duration-500 ease-out',
                  showRich ? 'opacity-100' : 'opacity-0',
                )}
              >
                {/* `active` flips with the dissolve: the mark holds front-on (edges lit, body
                    hidden) through the swap, then materializes its body and eases into its tilt +
                    idle tumble — all 3D depth/motion is after, never during. */}
                <FrinkScene
                  className="absolute! inset-0"
                  active={showRich}
                  onReady={() => setSceneReady(true)}
                />
              </div>
            </Suspense>
          )}
        </div>
      </div>

      {/* Headline — the centrepiece, at exact viewport centre. The HEAD treatment: a serif
          (Instrument Serif, falling back to Georgia) under the spectrum shimmer sweep. */}
      <div className="flex items-center justify-center">
        <TextShimmer
          as="h1"
          variant="spectrum"
          duration={2.4}
          spread={10}
          className="font-['Instrument_Serif',Georgia,serif] text-6xl font-normal leading-none tracking-tight sm:text-7xl"
        >
          Welcome to Frink.
        </TextShimmer>
      </div>

      {/* CTA — just below the centred headline. */}
      <div className="flex flex-col items-center justify-start gap-3 pt-10">
        <Button
          onClick={onDismiss}
          size="lg"
          className={cn(
            'flex h-11 rounded-full px-9 text-sm',
            'transition-[background-color,transform] duration-150 active:scale-[0.98]',
            BUTTON_SHADOW,
          )}
        >
          Get started
        </Button>
      </div>
    </div>
  );
}
