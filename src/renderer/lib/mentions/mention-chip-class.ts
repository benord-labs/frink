import { cva } from 'class-variance-authority';

// Shell and accent proportions adapted from T3 Code's ContextChip (MIT, Copyright (c) 2026 T3 Tools Inc.).
/** A mention or attached file as one badge wherever it shows: composer, attachment strip, transcript.
 * Its label shares the baseline of the text around it; icons and buttons are centred on the badge. */
export const mentionChipClass = cva(
  'inline-flex h-5 max-w-full min-w-0 items-baseline gap-1 rounded-md border px-1.5 align-baseline text-xs leading-4.5 font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary [button&]:cursor-pointer [button&]:transition-colors [&>span]:min-w-0 [&>span]:truncate [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:self-center [&>button]:self-center',
  {
    variants: {
      // Icons darken on the light fill so pale file-type colours stay visible,
      // and take the text colour on the selected fill.
      selected: {
        false:
          'border-[color:color-mix(in_oklab,var(--color-primary)_34%,var(--color-border))] bg-primary/11 text-[color:color-mix(in_oklab,var(--color-primary)_22%,var(--color-foreground))] [button&]:hover:border-[color:color-mix(in_oklab,var(--color-primary)_48%,var(--color-border))] [button&]:hover:bg-primary/17 [&>svg]:brightness-60 dark:[&>svg]:brightness-100',
        true: 'border-primary bg-primary text-primary-foreground [&>svg]:brightness-0 [&>svg]:invert dark:[&>svg]:invert-0',
      },
    },
    defaultVariants: { selected: false },
  },
);
