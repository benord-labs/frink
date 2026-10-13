import { Button } from '@benord-labs/frink-primitives';
import { X, Loader2 } from 'lucide-react';
import type { ComponentProps, ComponentType } from 'react';
import { getFileIconByExtension } from '@/lib/mentions/agents-file-mention-icons';
import { mentionChipClass } from '@/lib/mentions/mention-chip-class';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import { formatFileSize } from '../../file-viewer/utils/file-utils';

type AgentFileItemProps = Omit<ComponentProps<'button'>, 'children'> & {
  filename: string;
  /** Full path, shown in the name's tooltip. */
  path?: string;
  /** Replaces the file-type icon, for attachments that are not files. */
  icon?: ComponentType;
  size?: number;
  /** Short suffix after the name, such as a line range; shown in place of the size. */
  detail?: string;
  isLoading?: boolean;
  /** Draws the badge as a real button, for one that does something when pressed. */
  asButton?: boolean;
  /** Keeps the badge out of a selection drawn across it, so a copy takes none of it. */
  skipSelection?: boolean;
  onRemove?: () => void;
  /** Accessible name of the remove control; defaults to "Remove <filename>". */
  removeLabel?: string;
};

/** The badge's own element: a real button when pressing it does something, else a span. */
function Chip({ asButton, ...props }: ComponentProps<'button'> & { asButton: boolean }) {
  return asButton ? <button type="button" {...props} /> : <span {...props} />;
}

// Chromium ends a copied line on leaving a box, even one that cannot be selected, unless the
// last thing inside that box has no box of its own. Text held this way keeps the line whole.
function BoxlessText({ children }: { children: string }) {
  return <span className="contents">{children}</span>;
}

/** An attachment as a mention badge: icon, name and an optional size or line range. */
export function AgentFileItem({
  filename,
  path,
  icon,
  size,
  detail,
  isLoading = false,
  asButton = false,
  skipSelection = false,
  onRemove,
  removeLabel = `Remove ${filename}`,
  className,
  ...props
}: AgentFileItemProps) {
  // biome-ignore lint/style/useNamingConvention: Renders as a JSX component
  const Icon = icon ?? getFileIconByExtension(filename);
  const suffix = detail ?? (size === undefined ? undefined : formatFileSize(size));
  const text = (value: string) => (skipSelection ? <BoxlessText>{value}</BoxlessText> : value);
  const name = <span>{text(filename)}</span>;

  return (
    <Chip
      asButton={asButton}
      className={cn(mentionChipClass(), skipSelection && 'select-none', className)}
      {...props}
    >
      {isLoading ? <Loader2 className="animate-spin" /> : <Icon />}
      {path ? (
        <Tooltip>
          <TooltipTrigger asChild>{name}</TooltipTrigger>
          <TooltipContent side="top" className="font-mono wrap-anywhere">
            {path}
          </TooltipContent>
        </Tooltip>
      ) : (
        name
      )}
      {suffix && (
        <span className="shrink-0 font-normal tabular-nums before:mr-1 before:content-['·']">
          {text(suffix)}
        </span>
      )}
      {onRemove && (
        <Button
          variant="ghost"
          size="icon"
          aria-label={removeLabel}
          title={removeLabel}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="-mr-1 size-4 shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" />
        </Button>
      )}
    </Chip>
  );
}
