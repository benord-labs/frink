import { SquareDashedText } from 'lucide-react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../../components/ui/hover-card';
import { AgentFileItem } from './agent-file-item';

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
  return (
    <HoverCard openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>
        <AgentFileItem
          filename={preview.trim().split('\n')[0]}
          icon={SquareDashedText}
          size={size}
          className="max-w-48"
          removeLabel="Remove pasted text"
          onRemove={onRemove}
        />
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
