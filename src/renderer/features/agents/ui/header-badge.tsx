import { Button } from '@benord-labs/frink-primitives';
import { forwardRef, memo, type ReactNode } from 'react';
import { cn } from '../../../lib/utils';

/** `min-w-0 shrink` so badges yield width in tight headers (e.g. multi-pane + account pill). */
const badgeLayoutClass =
  'inline-flex items-center px-2 py-0.5 rounded-full min-w-0 shrink bg-muted/50 text-muted-foreground text-[11px] font-medium select-none';

const interactiveButtonClass = cn(
  badgeLayoutClass,
  'cursor-pointer border-0 shadow-none font-sans text-left',
  'motion-safe:active:scale-[0.99] transition-[transform,background-color] duration-150 ease-out',
  'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
);

type ButtonBranchProps = {
  children: ReactNode;
  className?: string;
  onClick: React.MouseEventHandler<HTMLButtonElement>;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className' | 'type'>;

type DivBranchProps = {
  children: ReactNode;
  className?: string;
  onClick?: undefined;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'children' | 'className'>;

/** Use with `DropdownMenuTrigger asChild` so Radix-merged handlers/refs are typed as a button. */
type MenuTriggerBranchProps = {
  children: ReactNode;
  className?: string;
  variant: 'menuTrigger';
} & Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'className' | 'type' | 'variant'
>;

type HeaderBadgeProps = ButtonBranchProps | DivBranchProps | MenuTriggerBranchProps;

function isInteractiveTriggerRest(
  rest: object,
): rest is React.ButtonHTMLAttributes<HTMLButtonElement> {
  const r = rest as Record<string, unknown>;
  return typeof r.onClick === 'function' || typeof r.onPointerDown === 'function';
}

const HeaderBadgeInner = forwardRef<HTMLButtonElement | HTMLDivElement, HeaderBadgeProps>(
  function HeaderBadgeInner(props, ref) {
    if ('variant' in props && props.variant === 'menuTrigger') {
      const { children, className, variant: _, ...rest } = props;
      return (
        <Button
          variant="ghost"
          {...rest}
          ref={ref as React.Ref<HTMLButtonElement>}
          className={cn(interactiveButtonClass, className)}
        >
          {children}
        </Button>
      );
    }

    const { children, className, ...rest } = props;

    if (isInteractiveTriggerRest(rest)) {
      const { variant: _variant, ...buttonRest } = rest as { variant?: unknown } & typeof rest;
      return (
        <Button
          variant="ghost"
          {...buttonRest}
          ref={ref as React.Ref<HTMLButtonElement>}
          className={cn(interactiveButtonClass, className)}
        >
          {children}
        </Button>
      );
    }

    const divRest = rest as Omit<React.HTMLAttributes<HTMLDivElement>, 'children' | 'className'>;
    return (
      <div
        ref={ref as React.Ref<HTMLDivElement>}
        className={cn(badgeLayoutClass, 'cursor-default', className)}
        {...divRest}
      >
        {children}
      </div>
    );
  },
);

HeaderBadgeInner.displayName = 'HeaderBadge';

export const HeaderBadge = memo(HeaderBadgeInner);
