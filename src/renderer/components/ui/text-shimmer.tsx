/**
 * Text shimmer for loading-style copy. `variant="spectrum"` is reserved for the
 * tool-planning status line (theme gradient sweep); other callers use `default`.
 */
import { motion } from 'motion/react';
import React, { type JSX, useEffect, useMemo, useState } from 'react';
import { usePrefersReducedMotion } from '../../hooks/use-prefers-reduced-motion';
import { cn } from '../../lib/utils';

export type TextShimmerVariant = 'default' | 'spectrum';

type TextShimmerProps = {
  children: React.ReactNode;
  as?: React.ElementType;
  className?: string;
  duration?: number;
  spread?: number;
  delay?: number;
  variant?: TextShimmerVariant;
};

function TextShimmerComponent({
  children,
  as: Component = 'p',
  className,
  duration = 2,
  spread = 2,
  delay = 0,
  variant = 'default',
}: TextShimmerProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  // biome-ignore lint/style/useNamingConvention: Renders as a component
  const MotionComponent = motion(Component as keyof JSX.IntrinsicElements);
  const [shouldAnimate, setShouldAnimate] = useState(delay === 0);

  useEffect(() => {
    if (delay > 0) {
      const timer = setTimeout(() => {
        setShouldAnimate(true);
      }, delay * 1000);
      return () => clearTimeout(timer);
    }
  }, [delay]);

  const dynamicSpread = useMemo(() => {
    if (typeof children === 'string') {
      return children.length * spread;
    }
    return 50 * spread;
  }, [children, spread]);

  if (prefersReducedMotion) {
    // createElement (not JSX) so a dynamic `ElementType` doesn't infer `children: never` under React 19.
    return React.createElement(
      Component,
      { className: cn('text-muted-foreground', className) },
      children,
    );
  }

  const isSpectrum = variant === 'spectrum';

  const backgroundImage = isSpectrum
    ? `linear-gradient(90deg,
        transparent 0%,
        transparent calc(50% - var(--spread)),
        hsl(var(--primary) / 0.95) calc(50% - var(--spread) * 0.55),
        hsl(var(--ring) / 0.92) 50%,
        hsl(var(--pane-accent) / 0.95) calc(50% + var(--spread) * 0.55),
        transparent calc(50% + var(--spread)),
        transparent 100%
      ), linear-gradient(hsl(var(--muted-foreground)), hsl(var(--muted-foreground)))`
    : `var(--bg), linear-gradient(var(--base-color), var(--base-color))`;

  return (
    <MotionComponent
      className={cn(
        'relative inline-block bg-size-[250%_100%,auto] bg-clip-text',
        !isSpectrum && 'text-transparent [--base-color:#a1a1aa] [--base-gradient-color:#000]',
        !isSpectrum &&
          '[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--base-gradient-color),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]',
        !isSpectrum &&
          'dark:[--base-color:#71717a] dark:[--base-gradient-color:#ffffff] dark:[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--base-gradient-color),#0000_calc(50%+var(--spread)))]',
        isSpectrum && 'text-transparent [background-repeat:no-repeat,padding-box]',
        className,
      )}
      initial={{ backgroundPosition: '100% center' }}
      animate={
        shouldAnimate ? { backgroundPosition: '0% center' } : { backgroundPosition: '100% center' }
      }
      transition={{
        repeat: shouldAnimate ? Infinity : 0,
        duration,
        ease: 'linear',
      }}
      style={
        {
          '--spread': `${dynamicSpread}px`,
          backgroundImage,
        } as React.CSSProperties
      }
    >
      {children}
    </MotionComponent>
  );
}

export const TextShimmer = React.memo(TextShimmerComponent);
