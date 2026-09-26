import { Input } from '@benord-labs/frink-primitives';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import type React from 'react';
import { Search } from 'lucide-react';
import { overlayGlass } from '@/lib/overlay-styles';
import { cn } from '@/lib/utils';

type SearchDialogShellProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  inputId: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  inputPlaceholder: string;
  inputValue: string;
  onInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  // `size` is omitted alongside the props this shell owns: it forwards to the primitives
  // Input, whose `size` is a height variant rather than the native character-width attribute.
  inputProps?: Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    'id' | 'ref' | 'value' | 'onChange' | 'placeholder' | 'className' | 'size'
  >;
  onKeyDown: (e: React.KeyboardEvent) => void;
  activePaneIndex?: number;
  paneDotClassName?: string;
  paneDotBorderClassName?: string;
  paneBorderClassName?: string;
  children: React.ReactNode;
  contentWidthClassName: string;
};

export function SearchDialogShell({
  open,
  onOpenChange,
  title,
  description,
  inputId,
  inputRef,
  inputPlaceholder,
  inputValue,
  onInputChange,
  inputProps,
  onKeyDown,
  activePaneIndex,
  paneDotClassName,
  paneDotBorderClassName,
  paneBorderClassName,
  children,
  contentWidthClassName,
}: SearchDialogShellProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/10 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:animate-none motion-reduce:transition-none" />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-[50%] top-3 z-50',
            contentWidthClassName,
            'max-w-[calc(100vw-32px)] rounded-[10px] border shadow-lg',
            overlayGlass,
            'p-0 flex flex-col overflow-hidden',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'motion-reduce:animate-none motion-reduce:transition-none',
            paneBorderClassName,
          )}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onKeyDown={onKeyDown}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            {description}
          </DialogPrimitive.Description>

          <div className="mx-1 my-1">
            <label htmlFor={inputId} className="sr-only">
              {title}
            </label>
            <div className="relative flex items-center gap-1.5 h-7 px-1.5 rounded-md bg-muted/50">
              {activePaneIndex != null && paneDotClassName ? (
                <span
                  role="img"
                  className={cn(
                    'h-2.5 w-2.5 rounded-full shrink-0 border',
                    paneDotClassName,
                    paneDotBorderClassName,
                  )}
                  aria-label={`Pane ${activePaneIndex + 1}`}
                />
              ) : null}
              <Search className="h-4 w-4 text-muted-foreground shrink-0" />
              <Input
                id={inputId}
                ref={inputRef}
                placeholder={inputPlaceholder}
                value={inputValue}
                onChange={onInputChange}
                {...inputProps}
                className="h-auto p-0 border-0 rounded-none bg-transparent placeholder:text-muted-foreground focus:ring-ring focus:ring-offset-1"
              />
            </div>
          </div>

          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
