import * as SliderPrimitive from '@radix-ui/react-slider';
import * as React from 'react';

import { cn } from '../../lib/utils';

/** Thumb diameter in px — Radix insets the thumb by half of it, so the fill and dots use it too. */
const THUMB_PX = 28;

/** A soft overshoot, so a step lands with a little spring (literal in GLIDE too — Tailwind scans source). */
const GLIDE_EASE = 'ease-[cubic-bezier(0.22,1,0.36,1)]';

/** Radix positions the thumb's wrapper span with an inline `left`; easing it glides between stops. */
const GLIDE =
  '[&>span:has(>[role=slider])]:transition-[left] [&>span:has(>[role=slider])]:duration-300 [&>span:has(>[role=slider])]:ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:[&>span:has(>[role=slider])]:transition-none';

/**
 * Single-thumb pill slider. The fill runs to the thumb's far edge so its end always hides under the
 * thumb, and a stepped range (≤ 10 steps) draws a dot at every stop where Radix parks the thumb.
 */
const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & { thumbLabel?: string }
>(({ className, min = 0, max = 100, step = 1, thumbLabel, ...props }, ref) => {
  const stops = (max - min) / step;
  const current = (props.value ?? props.defaultValue)?.[0] ?? min;
  const fraction = max > min ? (current - min) / (max - min) : 0;
  const along = (f: number) => `(100% - ${THUMB_PX}px) * ${f}`;
  return (
    <SliderPrimitive.Root
      ref={ref}
      min={min}
      max={max}
      step={step}
      className={cn(
        'relative flex h-7 w-full touch-none select-none items-center data-[disabled]:opacity-50',
        GLIDE,
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-6 w-full grow overflow-hidden rounded-full bg-foreground/10">
        <span
          aria-hidden
          className={cn(
            'absolute inset-y-0 left-0 rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none',
            GLIDE_EASE,
          )}
          style={{ width: `calc(${THUMB_PX}px + ${along(fraction)})` }}
        />
      </SliderPrimitive.Track>
      {stops > 0 && stops <= 10
        ? Array.from({ length: stops + 1 }, (_, i) => (
            <span
              key={i}
              aria-hidden
              className="pointer-events-none absolute size-1.5 -translate-x-1/2 rounded-full bg-foreground/30"
              style={{ left: `calc(${THUMB_PX / 2}px + ${along(i / stops)})` }}
            />
          ))
        : null}
      <SliderPrimitive.Thumb
        aria-label={thumbLabel}
        className="block size-7 cursor-grab rounded-full bg-white shadow-md outline-none transition-transform duration-150 hover:scale-110 focus-visible:ring-4 focus-visible:ring-foreground/15 active:scale-95 active:cursor-grabbing motion-reduce:transition-none data-[disabled]:cursor-not-allowed data-[disabled]:hover:scale-100"
      />
    </SliderPrimitive.Root>
  );
});
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
