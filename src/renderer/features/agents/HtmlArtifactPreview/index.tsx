import { Button } from '@benord-labs/frink-primitives';
import { ChevronUp, MousePointer2, RefreshCw } from 'lucide-react';
import { type KeyboardEvent, type ReactElement, useEffect, useId } from 'react';
import { useHtmlArtifactPreview } from '../../../lib/hooks/html-artifact-preview';
import { useHtmlArtifactPane } from '../HtmlArtifactPane';

function handlePreviewKeyDown(event: KeyboardEvent<HTMLElement>, closeArtifact: () => void): void {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  closeArtifact();
}

function getPreviewCopy(
  error: string | null,
  pauseReason: string | null,
  isOpening: boolean,
  isReady: boolean,
) {
  if (error) return { message: error, recoveryLabel: 'Try again', status: 'Error' };
  if (pauseReason) {
    return { message: pauseReason, recoveryLabel: 'Resume artifact', status: 'Paused' };
  }
  return {
    message: isOpening ? 'Opening interactive result…' : 'Preparing interactive result…',
    recoveryLabel: null,
    status: isReady ? 'Running' : 'Opening',
  };
}

export function HtmlArtifactPreview(): ReactElement {
  const {
    surfaceId: paneSurfaceId,
    selection,
    isPaneActive,
    closeArtifact,
  } = useHtmlArtifactPane();
  const titleId = useId();
  const surfaceId = selection ? `${paneSurfaceId}:${selection.artifactId}` : paneSurfaceId;
  const preview = useHtmlArtifactPreview(surfaceId, selection, isPaneActive, closeArtifact);
  const copy = getPreviewCopy(
    preview.error,
    preview.pauseReason,
    preview.isOpening,
    preview.isReady,
  );

  useEffect(() => preview.surfaceRef.current?.focus(), [preview.surfaceRef]);
  useEffect(() => {
    if (preview.error) preview.recoveryRef.current?.focus();
  }, [preview.error, preview.recoveryRef]);

  return (
    <section
      ref={preview.surfaceRef}
      className="my-2 overflow-hidden rounded-md border border-border bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={(event) => handlePreviewKeyDown(event, closeArtifact)}
      data-html-artifact-preview
    >
      <header className="flex min-h-11 items-center gap-1 border-b bg-tl-background pl-3">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="truncate text-sm font-medium text-foreground">
            {selection?.title}
          </h2>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {copy.status}
          </p>
        </div>
        <Button
          ref={preview.interactRef}
          type="button"
          variant="ghost"
          size="xs"
          disabled={!preview.isReady}
          onClick={() => void preview.focus()}
        >
          <MousePointer2 className="size-3.5" aria-hidden="true" />
          Interact
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-10"
          disabled={!preview.isReady}
          onClick={() => void preview.reload()}
          aria-label="Reload artifact"
          title="Reload artifact"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-10"
          onClick={closeArtifact}
          aria-label="Collapse artifact"
          title="Collapse artifact"
        >
          <ChevronUp className="size-4" aria-hidden="true" />
        </Button>
      </header>
      <div className="relative aspect-video min-h-60 max-h-96 bg-background">
        <div
          ref={preview.placeholderRef}
          className="absolute inset-0"
          data-testid="artifact-preview-slot"
        />
        {!preview.isReady ? (
          <div
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center text-sm text-muted-foreground"
            role={preview.error ? 'alert' : 'status'}
          >
            <p>{copy.message}</p>
            {copy.recoveryLabel ? (
              <Button
                ref={preview.recoveryRef}
                type="button"
                variant="secondary"
                size="xs"
                onClick={() => void preview.resume()}
              >
                {copy.recoveryLabel}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
