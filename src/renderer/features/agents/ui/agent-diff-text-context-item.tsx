import { Button } from '@benord-labs/frink-primitives';
import { X, SquareDashedText, SquareDashedBottomCode } from 'lucide-react';
import { useState } from 'react';
import { isPlanFile } from './agent-tool-utils';

type AgentDiffTextContextItemProps = {
  text: string;
  preview: string;
  filePath: string;
  lineNumber?: number;
  lineType?: 'old' | 'new';
  onRemove?: () => void;
};

export function AgentDiffTextContextItem({
  text: _text,
  preview: _preview,
  filePath,
  lineNumber,
  lineType,
  onRemove,
}: AgentDiffTextContextItemProps) {
  const [isHovered, setIsHovered] = useState(false);

  // Check if this is a plan selection
  const isPlan = isPlanFile(filePath);

  // Extract just the filename from the path
  const fileName = filePath.split('/').pop() || filePath;

  return (
    <div
      className="relative flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-muted/50 cursor-default min-w-[120px] max-w-[200px]"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      role="none"
    >
      {/* Icon container */}
      <div className="flex items-center justify-center size-8 rounded-md bg-muted shrink-0">
        {isPlan ? (
          <SquareDashedText className="size-4 text-muted-foreground" />
        ) : (
          <SquareDashedBottomCode className="size-4 text-muted-foreground" />
        )}
      </div>

      {/* Text content */}
      <div className="flex flex-col min-w-0">
        <span className="text-sm font-medium text-foreground truncate">
          {isPlan ? 'Plan' : fileName}
        </span>
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          {isPlan ? (
            'Text selection'
          ) : (
            <>
              {lineNumber && <span>Line {lineNumber}</span>}
              {lineType && (
                <span className={lineType === 'new' ? 'text-green-500' : 'text-red-500'}>
                  {lineNumber ? '· ' : ''}
                  {lineType === 'new' ? 'Added' : 'Removed'}
                </span>
              )}
              {!lineNumber && !lineType && 'Code selection'}
            </>
          )}
        </span>
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
  );
}
