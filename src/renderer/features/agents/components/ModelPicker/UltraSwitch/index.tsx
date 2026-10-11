import { type ReactElement, useId } from 'react';
import { Switch } from '../../../../../components/ui/switch';

const ULTRA_HINT = 'Runs many agents at once. Uses your plan faster.';

/** Ultra sits beside effort, not on it: the CLI runs its parallel agents at whatever effort is set. */
export function UltraSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
}): ReactElement {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border/50 pt-3">
      <label htmlFor={id} className="flex min-w-0 cursor-pointer flex-col">
        <span className="text-sm font-medium">{checked ? <UltraWord /> : 'Ultra'}</span>
        <span className="text-xs leading-snug text-muted-foreground">{ULTRA_HINT}</span>
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} aria-label="Ultra" />
    </div>
  );
}

/** Ultra's word (or another word standing in for it), in the animated chroma Frink uses for power
 *  keywords. Text only: the chroma fill is transparent, so it must not wrap `currentColor` icons. */
export function UltraWord({ children = 'Ultra' }: { children?: string }): ReactElement {
  return <span className="chroma-text chroma-text-animate font-medium">{children}</span>;
}
