import type * as React from 'react';
import { cn } from '../../lib/utils';

/**
 * The Frink app mark used by the pre-React shell (`index.html`) and {@link PageLoader}.
 * Same two paths / viewBox — keep in sync with `src/renderer/index.html` loading `<svg>`.
 */
export function FrinkLoadingLogo({
  className,
  children,
  'aria-hidden': ariaHiddenProp,
  ...props
}: React.SVGProps<SVGSVGElement>) {
  const ariaHidden = ariaHiddenProp ?? (children ? undefined : true);
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: title is `children` (PageLoader) or default below
    <svg
      className={cn('shrink-0', className)}
      viewBox="0 0 500 500"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={ariaHidden}
      {...props}
    >
      {children ?? <title>Frink</title>}
      <path
        fill="currentColor"
        d="M350.3 166.97L244.64 229.85C237.67 234 233.44 241.34 233.46 249.24C233.59 291.18 233.7 333.12 233.84 375.04L149.69 426.42V219.37C149.69 204.69 157.5 191.03 170.37 183.19L350.3 73.59V166.97Z"
      />
      <path
        fill="currentColor"
        d="M350.3 199.41V285.79L260.18 340.79V263.8C260.18 257.46 263.57 251.57 269.15 248.22L350.3 199.41Z"
      />
    </svg>
  );
}
