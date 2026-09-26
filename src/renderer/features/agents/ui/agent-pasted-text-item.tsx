import { Button } from '@benord-labs/frink-primitives';
import { X, SquareDashedText } from 'lucide-react';
import { useState } from 'react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../../components/ui/hover-card';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

type AgentPastedTextItemProps = {
  filePath: string;
  filename: string;
  size: number;
  preview: string;
  onRemove?: () => void;
};

export function AgentPastedTextItem({
  filePath: _filePath,
  filename: _filename,
  size,
  preview,
  onRemove,
}: AgentPastedTextItemProps) {
  const [isHovered, setIsHovered] = useState(false);

  // Get a short title from the preview
  const title = preview.split('\n')[0]?.slice(0, 20) || preview.slice(0, 20);
  const displayTitle = title.length < preview.length ? `${title}...` : title;

  return (
    <HoverCard openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>
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
            <span className="text-xs text-muted-foreground">Pasted Text · {formatSize(size)}</span>
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
              className={`absolute -top-1.5 -right-1.5 size-4 rounded-full bg-background border border-border
                         transition-[opacity,transform] duration-150 ease-out active:scale-[0.97] z-10
                         ${isHovered ? 'opacity-100' : 'opacity-0'}`}
            >
              <X className="size-3" />
            </Button>
          )}
        </div>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start" className="w-80">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <SquareDashedText className="size-3" />
            <span>Pasted text · {formatSize(size)}</span>
          </div>
          <pre className="text-sm whitespace-pre-wrap wrap-break-word font-mono max-h-32 overflow-y-auto">
            {preview}
          </pre>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
