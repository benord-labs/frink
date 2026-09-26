import type React from 'react';
import { createContext, useContext, useState } from 'react';
import { cn } from '../../lib/utils';

type PromptInputContextType = {
  isLoading: boolean;
  value: string;
  setValue: (_value: string) => void;
  maxHeight: number | string;
  onSubmit?: () => void;
  disabled?: boolean;
  contextItems?: React.ReactNode;
};

const PromptInputContext = createContext<PromptInputContextType>({
  isLoading: false,
  value: '',
  setValue: () => {},
  maxHeight: 240,
  onSubmit: undefined,
  disabled: false,
  contextItems: null,
});

function usePromptInput() {
  const context = useContext(PromptInputContext);
  if (!context) {
    throw new Error('usePromptInput must be used within a PromptInput');
  }
  return context;
}

type PromptInputProps = {
  isLoading?: boolean;
  value?: string;
  onValueChange?: (_value: string) => void;
  maxHeight?: number | string;
  onSubmit?: () => void;
  children: React.ReactNode;
  className?: string;
  contextItems?: React.ReactNode;
};

function PromptInput({
  className,
  isLoading = false,
  maxHeight = 240,
  value,
  onValueChange,
  onSubmit,
  children,
  contextItems,
}: PromptInputProps) {
  const [internalValue, setInternalValue] = useState(value || '');

  const handleChange = (newValue: string) => {
    setInternalValue(newValue);
    onValueChange?.(newValue);
  };

  return (
    <PromptInputContext.Provider
      value={{
        isLoading,
        value: value ?? internalValue,
        setValue: onValueChange ?? handleChange,
        maxHeight,
        onSubmit,
        contextItems,
      }}
    >
      <div className={cn('flex flex-col gap-2', className)}>{children}</div>
    </PromptInputContext.Provider>
  );
}

type PromptInputActionsProps = React.HTMLAttributes<HTMLDivElement>;

function PromptInputActions({ children, className, ...props }: PromptInputActionsProps) {
  return (
    <div className={cn('flex items-center gap-2 min-w-0', className)} {...props}>
      {children}
    </div>
  );
}

// Used for displaying context items (components, shapes, etc.) that are added to the chat context
function PromptInputContextItems() {
  const { contextItems } = usePromptInput();

  if (!contextItems) return null;

  return <>{contextItems}</>;
}

export { PromptInput, PromptInputActions, PromptInputContextItems };
