import * as PopoverPrimitive from '@radix-ui/react-popover';
import * as React from 'react';
import {
  overlayAnimation,
  overlayContentBase,
  overlayMaxHeight,
  overlaySlideIn,
} from '../../lib/overlay-styles';
import { cn } from '../../lib/utils';

const Popover = PopoverPrimitive.Root;

const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverAnchor = PopoverPrimitive.Anchor;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = 'center', sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        overlayContentBase,
        overlayMaxHeight,
        overlayAnimation,
        overlaySlideIn,
        'min-w-[200px] py-1',
        className,
      )}
      data-popover="true"
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger };
