import type { KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { STRINGS } from '../../constants';

type FrinkLogoProps = {
  className?: string;
  onClick?: () => void;
  /**
   * When `onClick` is set, `role` is `button` and this name should describe
   * the action (defaults to a short action-oriented label). When not interactive,
   * `role` is `img` and this overrides the default wordmark label ("Frink").
   */
  ariaLabel?: string;
};

const DEFAULT_FRINK_LOGO_DECORATIVE_LABEL = 'Frink';

/**
 * Frink wordmark (icon + text). Text paths extracted from the designer's
 * embedded TT Firs Neue font via fontTools — no runtime font dependency.
 * Icon fill uses CSS --primary; text uses currentColor.
 */
export function FrinkLogo({ className, onClick, ariaLabel }: FrinkLogoProps) {
  const isInteractive = onClick !== undefined;
  const handleKeyDown = !isInteractive
    ? undefined
    : (e: KeyboardEvent<SVGSVGElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      };

  return (
    <svg
      role={isInteractive ? 'button' : 'img'}
      aria-label={
        isInteractive
          ? (ariaLabel ?? STRINGS.FRINK_LOGO_INTERACTIVE)
          : (ariaLabel ?? DEFAULT_FRINK_LOGO_DECORATIVE_LABEL)
      }
      onClick={onClick}
      onKeyDown={handleKeyDown}
      tabIndex={isInteractive ? 0 : undefined}
      className={cn('select-none', isInteractive && 'cursor-pointer', className)}
      viewBox="47 174 389 134"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* "Frink" text — outlined from TT Firs Neue, uses currentColor */}
      <g fill="currentColor">
        <path
          d="M80 0V700H555V615H170V375H475V290H170V0Z"
          transform="translate(131.36,289.03) scale(0.14193,-0.14193)"
        />
        <path
          d="M70 0V500H150V420H151Q170 456 209.5 480.5Q249 505 305 505H365V425H305Q261 425 225.5 405.0Q190 385 170.0 349.5Q150 314 150 270V0Z"
          transform="translate(206.58,289.03) scale(0.14193,-0.14193)"
        />
        <path
          d="M70 0V500H150V0ZM110 595Q88 595 71.5 611.5Q55 628 55 650Q55 673 71.5 689.0Q88 705 110 705Q133 705 149.0 689.0Q165 673 165 650Q165 628 149.0 611.5Q133 595 110 595Z"
          transform="translate(254.84,289.03) scale(0.14193,-0.14193)"
        />
        <path
          d="M70 0V500H150V425H151Q174 461 217.5 485.5Q261 510 320 510Q411 510 465.5 452.5Q520 395 520 295V0H440V290Q440 363 404.0 399.0Q368 435 305 435Q260 435 225.0 414.5Q190 394 170.0 356.5Q150 319 150 270V0Z"
          transform="translate(280.39,289.03) scale(0.14193,-0.14193)"
        />
        <path
          d="M70 0V700H150V300H250L410 500H505L320 265L520 0H420L250 225H150V0Z"
          transform="translate(357.74,289.03) scale(0.14193,-0.14193)"
        />
      </g>

      {/* Icon mark — uses theme primary */}
      <path
        fillRule="nonzero"
        fill="hsl(var(--primary))"
        d="M122.55,211.54l-37.51,22.32c-2.47,1.47-3.98,4.08-3.97,6.88.05,14.89.08,29.78.13,44.66l-29.87,18.24v-73.51c0-5.21,2.77-10.06,7.34-12.84,21.29-12.97,42.58-25.94,63.87-38.91v33.15Z"
      />
      <path
        fillRule="nonzero"
        fill="hsl(var(--primary))"
        d="M122.55,223.06v30.67c-10.66,6.51-21.33,13.02-31.99,19.52v-27.33c0-2.25,1.2-4.34,3.18-5.53,9.6-5.78,19.21-11.55,28.81-17.33Z"
      />
    </svg>
  );
}
