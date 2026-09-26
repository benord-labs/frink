import { motion } from 'motion/react';
import { usePrefersReducedMotion } from '../../../../../hooks/use-prefers-reduced-motion';

/**
 * Reserves the generated image's footprint with a sweeping highlight. Foreground-tinted on purpose:
 * `bg-muted` is near-invisible on the dark theme.
 */
export function ImagePlaceholder() {
  const prefersReducedMotion = usePrefersReducedMotion();
  return (
    <div
      data-slot="image-placeholder"
      className="relative h-72 w-72 max-w-full overflow-hidden rounded-md bg-foreground/[0.06]"
    >
      {!prefersReducedMotion && (
        <motion.div
          className="absolute inset-y-0 w-1/2 bg-linear-to-r from-transparent via-foreground/10 to-transparent"
          initial={{ x: '-100%' }}
          animate={{ x: '300%' }}
          transition={{ repeat: Number.POSITIVE_INFINITY, duration: 1.6, ease: 'linear' }}
        />
      )}
    </div>
  );
}
