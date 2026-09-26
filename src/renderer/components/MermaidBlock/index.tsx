import { Button } from '@benord-labs/frink-primitives';
import { AlertTriangle, Check, Copy, Maximize2, RotateCcw } from 'lucide-react';
import { memo, useState } from 'react';
import { useMermaidDiagram } from '@/lib/agent-chat/mermaid/use-mermaid-diagram';
import { TextShimmer } from '../ui/text-shimmer';
import { DiagramButton } from './DiagramButton';
import { DiagramViewer } from './DiagramViewer';

type MermaidBlockProps = {
  code: string;
  isStreaming?: boolean;
};

type DiagramErrorProps = {
  code: string;
  message: string;
  invalid: boolean;
  onRetry: () => void;
};

const COPIED_RESET_MS = 2000;

function DiagramError({ code, message, invalid, onRetry }: DiagramErrorProps) {
  return (
    <div className="w-full text-sm">
      <p className="flex items-center gap-2 font-medium text-foreground">
        <AlertTriangle className="size-4 shrink-0 text-destructive" />
        This diagram couldn't be drawn
      </p>
      <p className="mt-1 text-muted-foreground">
        {invalid
          ? "Part of its code isn't valid. Ask the agent to fix the diagram."
          : 'Something went wrong while drawing it. Try again.'}
      </p>
      {!invalid && (
        <Button variant="secondary" size="sm" onClick={onRetry} className="mt-3 gap-1.5">
          <RotateCcw className="size-3.5" />
          Try again
        </Button>
      )}
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
          Show details
        </summary>
        <p className="mt-2 text-xs text-destructive wrap-break-word">{message}</p>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-xs wrap-break-word">
          {code}
        </pre>
      </details>
    </div>
  );
}

/** A ```mermaid block in chat, drawn in the active Frink theme and expandable to a zoomable viewer. */
export const MermaidBlock = memo(function MermaidBlock({
  code,
  isStreaming = false,
}: MermaidBlockProps) {
  const [diagram, retry] = useMermaidDiagram(code, isStreaming);
  // The viewer keeps the drawing it opened with, so a later redraw never reopens or swaps it.
  const [expandedSvg, setExpandedSvg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const copyCode = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_RESET_MS);
    });
  };

  return (
    <div className="relative mt-2 mb-4 overflow-hidden rounded-lg bg-muted/50">
      <div className="absolute top-1.5 right-1.5 z-2 flex gap-0.5">
        <DiagramButton label={copied ? 'Copied' : 'Copy diagram code'} onClick={copyCode}>
          {copied ? <Check /> : <Copy />}
        </DiagramButton>
        {diagram.status === 'ready' && (
          <DiagramButton label="Expand diagram" onClick={() => setExpandedSvg(diagram.svg)}>
            <Maximize2 />
          </DiagramButton>
        )}
      </div>

      <div className="flex min-h-15 items-center justify-center p-4">
        {diagram.status === 'drawing' && (
          <TextShimmer as="span" className="text-sm">
            Drawing diagram…
          </TextShimmer>
        )}
        {diagram.status === 'ready' && (
          // eslint-disable-next-line no-restricted-syntax -- clickable SVG region, not a styled Button
          <button
            type="button"
            className="w-full cursor-zoom-in overflow-x-auto [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
            onClick={() => setExpandedSvg(diagram.svg)}
            aria-label="Expand diagram"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: DOMPurify-sanitised by mermaid.render() (securityLevel 'strict')
            dangerouslySetInnerHTML={{ __html: diagram.svg }}
          />
        )}
        {diagram.status === 'error' && (
          <DiagramError
            code={code}
            message={diagram.message}
            invalid={diagram.invalid}
            onRetry={retry}
          />
        )}
      </div>

      {expandedSvg && <DiagramViewer svg={expandedSvg} onClose={() => setExpandedSvg(null)} />}
    </div>
  );
});
