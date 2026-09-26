import { Button } from '@benord-labs/frink-primitives';
import { GitBranch, Check, ChevronDown, Laptop } from 'lucide-react';
import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover';
import { cn } from '../../../lib/utils';
import type { WorkMode } from '../atoms';

type WorkModeSelectorProps = {
  value: WorkMode;
  onChange: (mode: WorkMode) => void;
  disabled?: boolean;
};

const workModeOptions = [
  {
    id: 'local' as const,
    label: 'Local',
    description: 'Works in your project folder. Changes show up right away.',
    icon: Laptop,
  },
  {
    id: 'worktree' as const,
    label: 'Worktree',
    description:
      'Works in a separate copy on its own branch. Your folder stays untouched until you merge.',
    icon: GitBranch,
  },
];

export function WorkModeSelector({ value, onChange, disabled }: WorkModeSelectorProps) {
  const [open, setOpen] = useState(false);
  const selectedOption = workModeOptions.find((opt) => opt.id === value) || workModeOptions[1];
  // biome-ignore lint/style/useNamingConvention: Renders as a component
  const Icon = selectedOption.icon;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'flex shrink-0 gap-1.5 px-2 py-1 text-sm transition-[background-color,color] duration-150 ease-out rounded-md',
            disabled && 'opacity-50 pointer-events-none',
          )}
          disabled={disabled}
        >
          <Icon className="w-4 h-4" />
          <span>{selectedOption.label}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72" align="start">
        {workModeOptions.map((option) => {
          // biome-ignore lint/style/useNamingConvention: Renders as a component
          const OptionIcon = option.icon;
          const isSelected = value === option.id;
          return (
            <Button
              variant="ghost"
              key={option.id}
              onClick={() => {
                onChange(option.id);
                setOpen(false);
              }}
              className={cn(
                'flex items-start gap-2.5 py-2 px-2 mx-1 w-[calc(100%-8px)] h-auto text-sm justify-start text-left rounded-md cursor-default',
                isSelected
                  ? 'dark:bg-neutral-800 text-foreground'
                  : 'dark:hover:bg-neutral-800 hover:text-foreground',
              )}
            >
              <OptionIcon className="mt-0.5 h-4 w-4 text-muted-foreground shrink-0" />
              <span className="flex-1 min-w-0 whitespace-normal">
                <span className="block font-medium text-foreground">{option.label}</span>
                <span className="block mt-0.5 text-xs font-normal text-muted-foreground">
                  {option.description}
                </span>
              </span>
              {isSelected && <Check className="mt-0.5 h-4 w-4 shrink-0" />}
            </Button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
