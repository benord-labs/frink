import { Button } from '@benord-labs/frink-primitives';
import { motion } from 'motion/react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { memo, useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '@/hooks/use-prefers-reduced-motion';
import { BUTTON_SHADOW } from '@/lib/button-shadow';
import { cn } from '@/lib/utils';
import { LAUNCH_FLAGS } from '../../../shared/launch-flags';
import { Kbd } from '../ui/kbd';

const STORAGE_KEY = 'frink:has-seen-welcome';

// The brand violet, not --primary: the token flips blue in the light theme, the mark never does.
const MARK_VIOLET = '#7c5cff';

const EASE_OUT = [0.16, 1, 0.3, 1] as const;

const MARK_PATHS = [
  'M350.3 166.97L244.64 229.85C237.67 234 233.44 241.34 233.46 249.24C233.59 291.18 233.7 333.12 233.84 375.04L149.69 426.42V219.37C149.69 204.69 157.5 191.03 170.37 183.19L350.3 73.59V166.97Z',
  'M350.3 199.41V285.79L260.18 340.79V263.8C260.18 257.46 263.57 251.57 269.15 248.22L350.3 199.41Z',
];

const PROVIDER_NAMES = LAUNCH_FLAGS.codexAccounts ? 'Claude or OpenAI' : 'Claude';

/** The Frink mark. Animated, it draws its outline once and fills in; otherwise it is solid. */
function WelcomeMark({ animate }: { animate: boolean }) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative — the dialog carries the name
    <svg
      aria-hidden
      viewBox="140 64 220 372"
      className="h-[72px] w-[43px] overflow-visible"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {MARK_PATHS.map((d, index) =>
        animate ? (
          <motion.path
            key={d}
            d={d}
            fill={MARK_VIOLET}
            stroke={MARK_VIOLET}
            strokeWidth={7}
            strokeLinejoin="round"
            initial={{ pathLength: 0, fillOpacity: 0, strokeOpacity: 1 }}
            animate={{ pathLength: 1, fillOpacity: 1, strokeOpacity: 0 }}
            transition={{
              pathLength: { duration: 1.4, ease: EASE_OUT, delay: index * 0.15 },
              fillOpacity: { duration: 0.6, delay: 1.2 },
              strokeOpacity: { duration: 0.6, delay: 1.2 },
            }}
          />
        ) : (
          <path key={d} d={d} fill={MARK_VIOLET} />
        ),
      )}
    </svg>
  );
}

/** Fades content up into place after the mark starts drawing; static when motion is reduced. */
function Rise({
  delay,
  reduced,
  className,
  children,
}: {
  delay: number;
  reduced: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <motion.div
      className={className}
      initial={reduced ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: EASE_OUT, delay }}
    >
      {children}
    </motion.div>
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

/** The new-chat hero's voice: a flat mark, one headline, one line, one action. */
function WelcomeHero({ exiting, onDismiss }: { exiting: boolean; onDismiss: () => void }) {
  const reducedMotion = usePrefersReducedMotion();
  return (
    <div
      className={cn(
        'flex h-full w-full flex-col items-center justify-center px-8 text-center',
        'transition-all duration-300 ease-out',
        exiting ? 'translate-y-2 opacity-0' : 'translate-y-0 opacity-100',
      )}
    >
      <WelcomeMark animate={!reducedMotion} />
      <Rise reduced={reducedMotion} delay={0.25} className="mt-8">
        <h1 className="text-balance text-[2.75rem] font-medium leading-none tracking-tight">
          Welcome to Frink
        </h1>
        <p className="mx-auto mt-4 max-w-md text-base leading-relaxed text-muted-foreground text-pretty">
          Fine-tuned automations, for everyone.
        </p>
      </Rise>
      <Rise reduced={reducedMotion} delay={0.45} className="mt-9 flex flex-col items-center gap-4">
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
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          or press <Kbd aria-label="Enter">↵</Kbd>
        </p>
      </Rise>
      <p className="absolute inset-x-0 bottom-6 text-xs text-muted-foreground">
        Runs on your machine, with your own {PROVIDER_NAMES} account.
      </p>
    </div>
  );
}
