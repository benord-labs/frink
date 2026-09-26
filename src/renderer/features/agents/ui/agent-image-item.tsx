import { Button } from '@benord-labs/frink-primitives';
import { ImageOff, X, Loader2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../../components/ui/hover-card';
import { type FullscreenImage, ImageFullscreen } from './ImageFullscreen';

type AgentImageItemProps = {
  id: string;
  filename: string;
  url: string;
  isLoading?: boolean;
  onRemove?: () => void;
  /** All images in the group for gallery navigation */
  allImages?: FullscreenImage[];
  /** Index of this image in the group */
  imageIndex?: number;
};

export function AgentImageItem({
  id,
  filename,
  url,
  isLoading = false,
  onRemove,
  allImages,
  imageIndex = 0,
}: AgentImageItemProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Use allImages if provided, otherwise create single-image array
  const images = allImages || [{ id, filename, url }];

  const handleImageError = () => {
    setHasError(true);
  };

  const openFullscreen = () => {
    setIsFullscreen(true);
  };

  const closeFullscreen = useCallback(() => {
    setIsFullscreen(false);
  }, []);

  return (
    <>
      <div
        className="relative"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        role="none"
      >
        {isLoading ? (
          <div className="size-8 flex items-center justify-center bg-muted rounded">
            <Loader2 className="size-4 text-muted-foreground animate-spin" />
          </div>
        ) : hasError ? (
          <div
            className="size-8 flex items-center justify-center bg-muted/50 rounded border border-destructive/20"
            title="Failed to load image"
          >
            <ImageOff className="size-4 text-destructive/50" />
          </div>
        ) : url ? (
          <HoverCard openDelay={200}>
            <HoverCardTrigger asChild>
              <img
                src={url}
                alt={filename}
                className="size-8 object-cover rounded cursor-pointer"
                onClick={openFullscreen}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openFullscreen();
                  }
                }}
                onError={handleImageError}
              />
            </HoverCardTrigger>
            <HoverCardContent className="w-auto max-w-72 p-0" side="top">
              <img
                src={url}
                alt={filename}
                className="max-w-72 max-h-72 w-auto h-auto object-contain rounded-[10px]"
                onError={handleImageError}
              />
            </HoverCardContent>
          </HoverCard>
        ) : (
          <div className="size-8 bg-muted rounded flex items-center justify-center">
            <Loader2 className="size-4 text-muted-foreground animate-spin" />
          </div>
        )}

        {onRemove && (
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className={`absolute -top-1.5 -right-1.5 size-4 rounded-full bg-background border border-border
                       flex items-center justify-center transition-[opacity,transform] duration-150 ease-out active:scale-[0.97] z-10
                       ${isHovered ? 'opacity-100' : 'opacity-0'}`}
          >
            <X className="size-3" />
          </Button>
        )}
      </div>

      {isFullscreen && (
        <ImageFullscreen images={images} initialIndex={imageIndex} onClose={closeFullscreen} />
      )}
    </>
  );
}
