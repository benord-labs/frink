import * as React from 'react';
import { overlayItem } from '../../lib/overlay-styles';
import { cn } from '../../lib/utils';
import { Search } from 'lucide-react';

// Context for keyboard navigation
type CommandContextValue = {
  selectedValue: string | null;
  setSelectedValue: (value: string | null) => void;
  onSelect: (value: string) => void;
  registerItem: (value: string, element: HTMLDivElement | null) => void;
  getItems: () => Map<string, HTMLDivElement>;
};

const CommandContext = React.createContext<CommandContextValue | null>(null);

type CommandProps = React.HTMLAttributes<HTMLDivElement> & {
  shouldFilter?: boolean;
  value?: string;
  onValueChange?: (value: string) => void;
};

/** Item keys in on-screen order, so keyboard navigation follows a list that reorders while open. */
function keysInDomOrder(items: Map<string, HTMLDivElement>): string[] {
  return [...items.entries()]
    .sort(([, a], [, b]) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    )
    .map(([key]) => key);
}

const Command = React.forwardRef<HTMLDivElement, CommandProps>(
  ({ className, shouldFilter, value, onValueChange, children, ...props }, ref) => {
    const [selectedValue, setSelectedValue] = React.useState<string | null>(null);
    const itemsRef = React.useRef<Map<string, HTMLDivElement>>(new Map());

    const registerItem = React.useCallback((value: string, element: HTMLDivElement | null) => {
      if (element) {
        itemsRef.current.set(value, element);
      } else {
        itemsRef.current.delete(value);
      }
    }, []);

    const getItems = React.useCallback(() => itemsRef.current, []);

    const onSelect = React.useCallback((value: string) => {
      const element = itemsRef.current.get(value);
      if (element) {
        element.click();
      }
    }, []);

    // Reset selection when items change
    React.useEffect(() => {
      if (itemsRef.current.size > 0 && !itemsRef.current.has(selectedValue ?? '')) {
        setSelectedValue(keysInDomOrder(itemsRef.current)[0] ?? null);
      }
    });

    const handleKeyDown = React.useCallback(
      (e: React.KeyboardEvent) => {
        const keys = keysInDomOrder(itemsRef.current);
        const currentIndex = selectedValue ? keys.indexOf(selectedValue) : -1;

        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault();
            if (keys.length > 0) {
              const nextIndex = currentIndex + 1 >= keys.length ? 0 : currentIndex + 1;
              const nextKey = keys[nextIndex];
              if (nextKey) {
                setSelectedValue(nextKey);
                itemsRef.current.get(nextKey)?.scrollIntoView({ block: 'nearest' });
              }
            }
            break;
          case 'ArrowUp':
            e.preventDefault();
            if (keys.length > 0) {
              const prevIndex = currentIndex - 1 < 0 ? keys.length - 1 : currentIndex - 1;
              const prevKey = keys[prevIndex];
              if (prevKey) {
                setSelectedValue(prevKey);
                itemsRef.current.get(prevKey)?.scrollIntoView({ block: 'nearest' });
              }
            }
            break;
          case 'Enter':
            e.preventDefault();
            if (selectedValue) {
              onSelect(selectedValue);
            }
            break;
          case 'Home':
            e.preventDefault();
            if (keys.length > 0) {
              const firstKey = keys[0];
              if (firstKey) {
                setSelectedValue(firstKey);
                itemsRef.current.get(firstKey)?.scrollIntoView({ block: 'nearest' });
              }
            }
            break;
          case 'End':
            e.preventDefault();
            if (keys.length > 0) {
              const lastKey = keys[keys.length - 1];
              if (lastKey) {
                setSelectedValue(lastKey);
                itemsRef.current.get(lastKey)?.scrollIntoView({ block: 'nearest' });
              }
            }
            break;
        }
      },
      [selectedValue, onSelect],
    );

    const contextValue = React.useMemo(
      () => ({
        selectedValue,
        setSelectedValue,
        onSelect,
        registerItem,
        getItems,
      }),
      [selectedValue, onSelect, registerItem, getItems],
    );

    return (
      <CommandContext.Provider value={contextValue}>
        <div
          ref={ref}
          role="menu"
          className={cn(
            'flex h-full w-full flex-col overflow-hidden text-popover-foreground',
            className,
          )}
          onKeyDown={handleKeyDown}
          {...props}
        >
          {children}
        </div>
      </CommandContext.Provider>
    );
  },
);
Command.displayName = 'Command';

type CommandInputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  onValueChange?: (value: string) => void;
  wrapperClassName?: string;
};

const CommandInput = React.forwardRef<HTMLInputElement, CommandInputProps>(
  ({ className, onValueChange, wrapperClassName, onChange, ...props }, ref) => {
    const localRef = React.useRef<HTMLInputElement>(null);
    const inputRef = (ref as React.RefObject<HTMLInputElement>) || localRef;

    // Auto-focus input when mounted
    React.useEffect(() => {
      // Small delay to ensure popover is rendered
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
      return () => clearTimeout(timer);
    }, [inputRef.current?.focus]);

    return (
      <div
        className={cn(
          'flex items-center gap-1.5 h-7 px-1.5 mx-1 my-1 rounded-md bg-muted/50',
          wrapperClassName,
        )}
        cmdk-input-wrapper=""
      >
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          className={cn(
            'flex-1 bg-transparent text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
          onChange={(e) => {
            onChange?.(e);
            onValueChange?.(e.target.value);
          }}
          {...props}
        />
      </div>
    );
  },
);
CommandInput.displayName = 'CommandInput';

const CommandList = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('max-h-[300px] overflow-y-auto overflow-x-hidden py-1', className)}
      {...props}
    />
  ),
);
CommandList.displayName = 'CommandList';

const CommandEmpty = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('py-6 text-center text-sm text-muted-foreground', className)}
      {...props}
    />
  ),
);
CommandEmpty.displayName = 'CommandEmpty';

type CommandGroupProps = React.HTMLAttributes<HTMLDivElement> & {
  heading?: string;
};

const CommandGroup = React.forwardRef<HTMLDivElement, CommandGroupProps>(
  ({ className, heading, children, ...props }, ref) => (
    <div ref={ref} className={cn('overflow-hidden text-foreground', className)} {...props}>
      {heading && (
        <div className="py-1.5 px-1.5 mx-1 text-xs font-medium text-muted-foreground">
          {heading}
        </div>
      )}
      {children}
    </div>
  ),
);
CommandGroup.displayName = 'CommandGroup';

type CommandItemProps = React.HTMLAttributes<HTMLDivElement> & {
  value?: string;
  onSelect?: () => void;
};

const CommandItem = React.forwardRef<HTMLDivElement, CommandItemProps>(
  ({ className, onSelect, value, onMouseEnter, ...props }, _ref) => {
    const context = React.useContext(CommandContext);
    const itemRef = React.useRef<HTMLDivElement>(null);

    // Generate a stable value if not provided - must call useId unconditionally
    const generatedId = React.useId();
    const itemValue = value || generatedId;

    // Register this item with the Command
    React.useEffect(() => {
      const element = itemRef.current;
      context?.registerItem(itemValue, element);
      return () => {
        context?.registerItem(itemValue, null);
      };
    }, [context, itemValue]);

    const isSelected = context?.selectedValue === itemValue;

    const handleMouseEnter = (e: React.MouseEvent<HTMLDivElement>) => {
      context?.setSelectedValue(itemValue);
      onMouseEnter?.(e);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        // Handled here, so Command's own Enter handler must not select this item a second time
        e.stopPropagation();
        if (onSelect) {
          onSelect();
        } else {
          context?.onSelect(itemValue);
        }
      }
    };

    return (
      <div
        ref={itemRef}
        role="menuitem"
        tabIndex={isSelected ? 0 : -1}
        data-value={itemValue}
        data-selected={isSelected || undefined}
        className={cn(
          overlayItem,
          isSelected && 'bg-accent dark:bg-neutral-800 text-accent-foreground',
          className,
        )}
        onClick={onSelect}
        onMouseEnter={handleMouseEnter}
        onKeyDown={handleKeyDown}
        {...props}
      />
    );
  },
);
CommandItem.displayName = 'CommandItem';

export { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList };
