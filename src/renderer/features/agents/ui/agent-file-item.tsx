import { Button } from '@benord-labs/frink-primitives';
import { X, Loader2 } from 'lucide-react';
import type { ComponentProps, ComponentType } from 'react';
import { getFileIconByExtension } from '@/lib/mentions/agents-file-mention-icons';
import { mentionChipClass } from '@/lib/mentions/mention-chip-class';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import { formatFileSize } from '../../file-viewer/utils/file-utils';

type AgentFileItemProps = Omit<ComponentProps<'span'>, 'children'> & {
  filename: string;
  /** Full path, shown in the name's tooltip. */
  path?: string;
  /** Replaces the file-type icon, for attachments that are not files. */
  icon?: ComponentType;
  size?: number;
  /** Short suffix after the name, such as a line range; shown in place of the size. */
  detail?: string;
  isLoading?: boolean;
  onRemove?: () => void;
  /** Accessible name of the remove control; defaults to "Remove <filename>". */
  removeLabel?: string;
};

/** An attachment as a mention badge: icon, name and an optional size or line range. */
export function AgentFileItem({
  filename,
  path,
  icon,
  size,
  detail,
  isLoading = false,
  onRemove,
  removeLabel = `Remove ${filename}`,
  className,
  ...props
}: AgentFileItemProps) {
  // biome-ignore lint/style/useNamingConvention: Renders as a JSX component
  const Icon = icon ?? getFileIconByExtension(filename);
  const suffix = detail ?? (size === undefined ? undefined : formatFileSize(size));
  const name = <span>{filename}</span>;

  return (
    <span className={cn(mentionChipClass(), className)} {...props}>
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
          {suffix}
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
    </span>
  );
}
