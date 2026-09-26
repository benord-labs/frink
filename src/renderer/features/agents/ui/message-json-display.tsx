import { Button } from '@benord-labs/frink-primitives';
import { Check, ChevronRight, Copy } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../../components/ui/collapsible';
import { cn } from '../../../lib/utils';
import { ShikiCodeBlock } from './shiki-code-block';

type MessageJsonDisplayProps = {
  message: unknown;
  label?: string;
};

export const MessageJsonDisplay = memo(function MessageJsonDisplay({
  message,
  label = 'Message',
}: MessageJsonDisplayProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const jsonString = JSON.stringify(message, null, 2);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(jsonString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [jsonString]);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="flex items-center gap-1">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="flex gap-1 px-2 py-1 text-xs rounded h-auto">
            <ChevronRight className={cn('h-3 w-3 transition-transform', isOpen && 'rotate-90')} />
            <span>{label} JSON</span>
          </Button>
        </CollapsibleTrigger>
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => {
            e.stopPropagation();
            handleCopy();
          }}
          className="p-1 rounded"
          title={copied ? 'Copied!' : 'Copy JSON'}
        >
          {copied ? (
            <Check className="h-3 w-3 text-green-500" />
          ) : (
            <Copy className="h-3 w-3 text-muted-foreground" />
          )}
        </Button>
      </div>
      <CollapsibleContent>
        <div className="mt-1 mx-2 rounded-md border bg-muted/30 overflow-hidden">
          <div className="p-3 max-h-[300px] overflow-auto">
            <ShikiCodeBlock
              code={jsonString}
              lang="json"
              className="text-xs font-mono whitespace-pre-wrap"
            />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});
