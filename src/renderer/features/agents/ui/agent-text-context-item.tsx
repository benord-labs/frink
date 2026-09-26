import { Button } from '@benord-labs/frink-primitives';
import { X, SquareDashedText } from 'lucide-react';
import { useState } from 'react';

type AgentTextContextItemProps = {
  text: string;
  preview: string;
  onRemove?: () => void;
};

export function AgentTextContextItem({
  text: _text,
  preview,
  onRemove,
}: AgentTextContextItemProps) {
  const [isHovered, setIsHovered] = useState(false);

  // Get a short title from the preview (first line or first ~15 chars)
  const title = preview.split('\n')[0]?.slice(0, 20) || preview.slice(0, 20);
  const displayTitle = title.length < preview.length ? `${title}...` : title;

  return (
    <div
      className="relative flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-muted/50 cursor-default min-w-[120px] max-w-[200px]"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      role="none"
    >
      {/* Icon container */}
      <div className="flex items-center justify-center size-8 rounded-md bg-muted shrink-0">
        <SquareDashedText className="size-4 text-muted-foreground" />
      </div>

      {/* Text content */}
      <div className="flex flex-col min-w-0">
        <span className="text-sm font-medium text-foreground truncate">{displayTitle}</span>
        <span className="text-xs text-muted-foreground">Selected Text</span>
      </div>

      {/* Remove button */}
      {onRemove && (
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label="Remove selected text"
          className={`absolute -top-1.5 -right-1.5 size-4 rounded-full bg-background border border-border
                     flex items-center justify-center transition-[opacity,transform] duration-150 ease-out active:scale-[0.97] z-10
                     ${isHovered ? 'opacity-100' : 'opacity-0'}`}
        >
          <X className="size-3" />
        </Button>
      )}
    </div>
  );
}
