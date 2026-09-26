import { Button } from '@benord-labs/frink-primitives';
import { FileCode, FileJson, FileText, X, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { formatFileSize } from '../../file-viewer/utils/file-utils';

type AgentFileItemProps = {
  id: string;
  filename: string;
  url: string;
  size?: number;
  isLoading?: boolean;
  onRemove?: () => void;
};

function getFileIcon(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase();

  // Code files
  if (
    [
      'js',
      'ts',
      'jsx',
      'tsx',
      'py',
      'rb',
      'go',
      'rs',
      'java',
      'kt',
      'swift',
      'c',
      'cpp',
      'h',
      'hpp',
      'cs',
      'php',
    ].includes(ext || '')
  ) {
    return FileCode;
  }

  // JSON/YAML/XML
  if (['json', 'yaml', 'yml', 'xml'].includes(ext || '')) {
    return FileJson;
  }

  return FileText;
}

export function AgentFileItem({
  id: _id,
  filename,
  url: _url,
  size,
  isLoading = false,
  onRemove,
}: AgentFileItemProps) {
  const [isHovered, setIsHovered] = useState(false);
  // biome-ignore lint/style/useNamingConvention: Renders as a JSX component
  const Icon = getFileIcon(filename);

  return (
    <div
      className="relative flex items-center gap-1.5 px-2 py-1 bg-muted/50 rounded border border-border/50 max-w-[200px]"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      role="none"
    >
      {isLoading ? (
        <Loader2 className="size-3.5 text-muted-foreground shrink-0 animate-spin" />
      ) : (
        <Icon className="size-3.5 text-muted-foreground shrink-0" />
      )}

      <div className="flex flex-col min-w-0">
        <span className="text-xs text-foreground truncate" title={filename}>
          {filename}
        </span>
        {size !== undefined && (
          <span className="text-[10px] text-muted-foreground">{formatFileSize(size)}</span>
        )}
      </div>

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
