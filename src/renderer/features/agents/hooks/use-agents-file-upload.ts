// File upload hook for desktop app with base64 conversion for Claude API
import { useCallback, useRef, useState } from 'react';

export type UploadedImage = {
  id: string;
  filename: string;
  url: string; // blob URL for preview
  base64Data?: string; // base64 encoded data for API
  isLoading: boolean;
  mediaType?: string; // MIME type e.g. "image/png", "image/jpeg"
};

/**
 * Convert a File to base64 data
 */
async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // Remove the data:image/xxx;base64, prefix
      const base64 = result.split(',')[1];
      resolve(base64 || '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Images travel inline; every other file goes to `onOtherFiles` (the pasted-file chips). */
export function useAgentsFileUpload(onOtherFiles?: (files: File[]) => Promise<void>) {
  const [images, setImages] = useState<UploadedImage[]>([]);
  // Counted, not a flag: a second drop must keep the composer busy after the first one finishes.
  const [pendingBatches, setPendingBatches] = useState(0);
  const onOtherFilesRef = useRef(onOtherFiles);
  onOtherFilesRef.current = onOtherFiles;

  const handleAddAttachments = useCallback(async (inputFiles: File[]) => {
    setPendingBatches((n) => n + 1);
    try {
      const imageFiles = inputFiles.filter((f) => f.type.startsWith('image/'));
      const otherFiles = inputFiles.filter((f) => !f.type.startsWith('image/'));

      // Process images with base64 conversion
      const newImages: UploadedImage[] = await Promise.all(
        imageFiles.map(async (file) => {
          const id = crypto.randomUUID();
          const filename = file.name || `screenshot-${Date.now()}.png`;
          const mediaType = file.type || 'image/png';
          const url = URL.createObjectURL(file);

          // Convert to base64 for API
          let base64Data: string | undefined;
          try {
            base64Data = await fileToBase64(file);
          } catch (_err) {}

          return {
            id,
            filename,
            url,
            base64Data,
            isLoading: false,
            mediaType,
          };
        }),
      );

      setImages((prev) => [...prev, ...newImages]);
      if (otherFiles.length > 0) await onOtherFilesRef.current?.(otherFiles);
    } finally {
      setPendingBatches((n) => n - 1);
    }
  }, []);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const clearImages = useCallback(() => {
    setImages([]);
  }, []);

  // Direct state setters for restoring from draft
  const setImagesFromDraft = useCallback((draftImages: UploadedImage[]) => {
    setImages(draftImages);
  }, []);

  return {
    images,
    handleAddAttachments,
    removeImage,
    clearImages,
    clearAll: clearImages,
    isUploading: pendingBatches > 0,
    setImagesFromDraft,
  };
}
