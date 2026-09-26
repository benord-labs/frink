import { Button } from '@benord-labs/frink-primitives';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export type FullscreenImage = {
  id: string;
  filename: string;
  url: string;
};

type ImageFullscreenProps = {
  images: FullscreenImage[];
  initialIndex?: number;
  onClose: () => void;
};

/** Fullscreen overlay with gallery navigation — rendered via portal to escape stacking context. */
export function ImageFullscreen({ images, initialIndex = 0, onClose }: ImageFullscreenProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const hasMultipleImages = images.length > 1;
  const currentImage = images[currentIndex] || images[0];

  const goToPrevious = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation();
      setCurrentIndex((prev) => (prev > 0 ? prev - 1 : images.length - 1));
    },
    [images.length],
  );

  const goToNext = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation();
      setCurrentIndex((prev) => (prev < images.length - 1 ? prev + 1 : 0));
    },
    [images.length],
  );

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          e.stopPropagation();
          onClose();
          break;
        case 'ArrowLeft':
          if (hasMultipleImages) goToPrevious();
          break;
        case 'ArrowRight':
          if (hasMultipleImages) goToNext();
          break;
      }
    };

    // Use capture phase to intercept before other handlers
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [hasMultipleImages, onClose, goToPrevious, goToNext]);

  if (!currentImage?.url) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          onClose();
        }
      }}
    >
      {/* Close button */}
      <Button
        variant="ghost"
        size="icon"
        onClick={onClose}
        className="absolute top-4 right-4 p-2 rounded-full bg-black/50 hover:bg-black/70 text-white z-10"
        aria-label="Close fullscreen (Esc)"
      >
        <X className="size-6" />
      </Button>

      {/* Previous button */}
      {hasMultipleImages && (
        <Button
          variant="ghost"
          size="icon"
          onClick={goToPrevious}
          className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/50 hover:bg-black/70 text-white z-10"
          aria-label="Previous image (←)"
        >
          <ChevronLeft className="size-8" />
        </Button>
      )}

      {/* Image */}
      <img
        src={currentImage.url}
        alt={currentImage.filename}
        className="max-w-[90vw] max-h-[85vh] object-contain"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      />

      {/* Next button */}
      {hasMultipleImages && (
        <Button
          variant="ghost"
          size="icon"
          onClick={goToNext}
          className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/50 hover:bg-black/70 text-white z-10"
          aria-label="Next image (→)"
        >
          <ChevronRight className="size-8" />
        </Button>
      )}

      {/* Image counter and dots */}
      {hasMultipleImages && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex flex-col items-center gap-3">
          {/* Dots indicator */}
          <div className="flex gap-2">
            {images.map((image, idx) => (
              <Button
                variant="ghost"
                size="icon"
                key={`image-${image.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setCurrentIndex(idx);
                }}
                className={`size-2 rounded-full transition-all ${
                  idx === currentIndex ? 'bg-white scale-125' : 'bg-white/40 hover:bg-white/60'
                }`}
                aria-label={`Go to image ${idx + 1}`}
              />
            ))}
          </div>
          {/* Counter text */}
          <span className="text-white/70 text-sm">
            {currentIndex + 1} / {images.length}
          </span>
        </div>
      )}
    </div>,
    document.body,
  );
}
