import { Button } from '@benord-labs/frink-primitives';
import type { ReactElement } from 'react';
import { ChevronsRight, Monitor } from 'lucide-react';
import { STRINGS } from '../constants';

type Props = {
  onClose: () => void;
};

/**
 * EmptyPreviewState - Shows when preview is not available
 * Displays helpful message about setting up repository
 */
export function EmptyPreviewState({ onClose }: Props): ReactElement {
  return (
    <div className="flex flex-col h-full">
      {/* Header with close button */}
      <div className="flex items-center justify-end px-3 h-10 bg-tl-background shrink-0 border-b border-border/50">
        <Button
          variant="ghost"
          className="h-7 w-7 p-0 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] rounded-md"
          onClick={onClose}
          aria-label="Close preview"
          iconOnly
        >
          <ChevronsRight className="h-4 w-4 text-muted-foreground" />
        </Button>
      </div>
      {/* Content */}
      <div className="flex flex-col items-center justify-center flex-1 p-6 text-center">
        <div className="text-muted-foreground mb-4">
          <Monitor className="size-12 opacity-50" strokeWidth={1.5} aria-hidden="true" />
        </div>
        <p className="text-sm text-muted-foreground mb-2">{STRINGS.PREVIEW_NOT_AVAILABLE}</p>
        <p className="text-xs text-muted-foreground/70 max-w-[200px]">
          {STRINGS.SET_UP_REPOSITORY_FOR_PREVIEW}
        </p>
      </div>
    </div>
  );
}
