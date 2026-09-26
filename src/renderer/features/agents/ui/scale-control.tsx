import { Button } from '@benord-labs/frink-primitives';
import { useEffect, useRef, useState } from 'react';
import { Popover, PopoverAnchor, PopoverContent } from '../../../components/ui/popover';
import { cn } from '../../../lib/utils';
import { AGENTS_PREVIEW_CONSTANTS } from '../constants';

// Regex patterns - hoisted to module level for performance
const NON_DIGIT_REGEX = /[^0-9]/g;

type ScaleControlProps = {
  value: number;
  onChange: (scale: number) => void;
  presets?: readonly number[];
  className?: string;
};

export function ScaleControl({
  value,
  onChange,
  presets = AGENTS_PREVIEW_CONSTANTS.SCALE_PRESETS,
  className,
}: ScaleControlProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState(String(value));
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync input value when value prop changes
  useEffect(() => {
    setInputValue(String(value));
  }, [value]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(NON_DIGIT_REGEX, '');
    setInputValue(raw);
    const num = parseInt(raw, 10);
    if (
      !Number.isNaN(num) &&
      num >= AGENTS_PREVIEW_CONSTANTS.MIN_SCALE &&
      num <= AGENTS_PREVIEW_CONSTANTS.MAX_SCALE
    ) {
      onChange(num);
    }
  };

  const handleCommit = () => {
    const num = parseInt(inputValue, 10);
    if (
      !Number.isNaN(num) &&
      num >= AGENTS_PREVIEW_CONSTANTS.MIN_SCALE &&
      num <= AGENTS_PREVIEW_CONSTANTS.MAX_SCALE
    ) {
      onChange(num);
      setInputValue(String(num));
    } else {
      setInputValue(String(value));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleCommit();
      setIsOpen(false);
      inputRef.current?.blur();
    }
    if (e.key === 'Escape') {
      setInputValue(String(value));
      setIsOpen(false);
      inputRef.current?.blur();
    }
  };

  return (
    <Popover
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          handleCommit();
          setIsOpen(false);
        }
      }}
    >
      <PopoverAnchor asChild>
        <Button
          variant="ghost"
          className={cn(
            'flex h-7 px-1.5 ml-1 rounded-md cursor-text',
            isOpen && 'bg-muted',
            className,
          )}
          onClick={(e) => {
            // If click is not on input, focus input
            if (e.target !== inputRef.current) {
              inputRef.current?.focus();
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              inputRef.current?.focus();
            }
          }}
          aria-label="Set preview scale percentage"
        >
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={handleInputChange}
            onFocus={(e) => {
              e.target.select();
              if (!isOpen) {
                setIsOpen(true);
              }
            }}
            onKeyDown={handleKeyDown}
            className="w-[3ch] text-xs text-muted-foreground bg-transparent border-none outline-hidden text-right tabular-nums"
          />
          <span className="text-xs text-muted-foreground">%</span>
        </Button>
      </PopoverAnchor>
      <PopoverContent
        className="w-(--radix-popover-trigger-width) min-w-[60px] p-0"
        align="start"
        side="bottom"
        sideOffset={4}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {presets.map((preset) => (
          <Button
            variant="ghost"
            key={preset}
            onClick={() => {
              onChange(preset);
              setInputValue(String(preset));
              setIsOpen(false);
            }}
            className={cn(
              'flex w-[calc(100%-8px)] mx-1 first:mt-1 last:mb-1 min-h-[32px] h-auto text-sm rounded-md',
              'dark:hover:bg-neutral-800',
              value === preset && 'dark:bg-neutral-800 bg-accent',
            )}
          >
            {preset}%
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
