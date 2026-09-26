import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import * as React from 'react';

import { overlayGlass } from '../../lib/overlay-styles';
import { cn } from '../../lib/utils';

const Dialog = DialogPrimitive.Root;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    showCloseButton?: boolean;
    onOverlayClick?: () => void;
    overlayClassName?: string;
    /** false when the caller brings its own non-glass fill: no glass material at all. */
    glass?: boolean;
  }
>(
  (
    {
      className,
      children,
      showCloseButton = true,
      onOverlayClick,
      overlayClassName,
      glass = true,
      ...props
    },
    ref,
  ) => (
    <DialogPortal>
      <DialogPrimitive.Overlay
        className={cn(
          'fixed inset-0 z-50 bg-black/10',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          overlayClassName,
        )}
        onClick={onOverlayClick}
      />
      <DialogPrimitive.Content
        ref={ref}
        data-canvas-dialog
        className={cn(
          'fixed left-[50%] top-[50%] z-50 grid w-[600px] max-w-[calc(100%-2rem)] max-h-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 border shadow-2xl p-6 duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] rounded-[16px] mx-auto',
          glass && overlayGlass,
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  ),
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-1.5 text-center sm:text-left', className)} {...props} />
);
DialogHeader.displayName = 'DialogHeader';

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)}
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

// Canvas-styled dialog content with header/content/footer sections
const CanvasDialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    showCloseButton?: boolean;
  }
>(({ className, children, showCloseButton = true, ...props }, ref) => (
  <DialogPortal>
    <DialogPrimitive.Overlay
      className={cn(
        'fixed inset-0 z-50 bg-black/10',
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      )}
    />
    <DialogPrimitive.Content
      ref={ref}
      data-canvas-dialog
      className={cn(
        'fixed left-[50%] top-[50%] z-50 w-[420px] max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] rounded-xl border shadow-2xl overflow-hidden',
        overlayGlass,
        'duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]',
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close className="absolute right-3 top-3 h-6 w-6 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors z-10">
          <X className="h-3.5 w-3.5" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
CanvasDialogContent.displayName = 'CanvasDialogContent';

// Header, body and footer are also the alert dialog's parts (re-exported by alert-dialog.tsx).
// Canvas dialog header (no border, just padding)
const CanvasDialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('px-5 py-4', className)} {...props} />
);
CanvasDialogHeader.displayName = 'CanvasDialogHeader';

// Canvas dialog body (content area)
const CanvasDialogBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('px-5 pb-5', className)} {...props} />
);
CanvasDialogBody.displayName = 'CanvasDialogBody';

// Canvas dialog footer: the dialog's own surface, set off by a hairline
const CanvasDialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('p-4 flex justify-end gap-2 border-t border-border', className)} {...props} />
);
CanvasDialogFooter.displayName = 'CanvasDialogFooter';

// One title for every dialog kind. Radix scopes Title per kind, so each kind passes in its own.
function createDialogTitle(Title: typeof DialogPrimitive.Title) {
  const StyledTitle = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Title>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
  >(({ className, ...props }, ref) => (
    <Title
      ref={ref}
      className={cn('text-lg font-semibold leading-none tracking-tight', className)}
      {...props}
    />
  ));
  StyledTitle.displayName = Title.displayName;
  return StyledTitle;
}

const DialogTitle = createDialogTitle(DialogPrimitive.Title);

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  CanvasDialogBody,
  // Canvas-styled variants
  CanvasDialogContent,
  CanvasDialogFooter,
  CanvasDialogHeader,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  createDialogTitle,
};
