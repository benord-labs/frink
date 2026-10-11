import type { TaskData } from '@/lib/tasks/format-task-message';
import { AgentImageItem } from '../ui/agent-image-item';
import { AgentPastedTextItem } from '../ui/agent-pasted-text-item';
import { AttachedTask } from './AttachedTask';

type Image = {
  id: string;
  filename: string;
  url: string | null;
  isLoading: boolean;
  mediaType?: string;
  base64Data?: string;
};

type PastedText = {
  id: string;
  filePath: string;
  filename: string;
  size: number;
  preview: string;
};

type ContextItemsProps = {
  images: Image[];
  pastedTexts: PastedText[];
  attachedTask?: TaskData | null;
  onRemoveImage: (id: string) => void;
  onRemovePastedText: (id: string) => void;
  onRemoveTask?: () => void;
  /** Extra chips for the end of the strip; pass null when there are none. */
  children?: React.ReactNode;
};

/**
 * Displays images and pasted text files as context items
 */
export function ContextItems({
  images,
  pastedTexts,
  attachedTask,
  onRemoveImage,
  onRemovePastedText,
  onRemoveTask,
  children,
}: ContextItemsProps) {
  if (images.length === 0 && pastedTexts.length === 0 && !attachedTask && !children) {
    return null;
  }

  // Build allImages array for gallery navigation
  const allImages = images
    .filter((img): img is Image & { url: string } => !!img.url && !img.isLoading)
    .map((img) => ({
      id: img.id,
      filename: img.filename,
      url: img.url,
    }));

  return (
    <div className="flex flex-col gap-2">
      {attachedTask && onRemoveTask && <AttachedTask task={attachedTask} onRemove={onRemoveTask} />}
      {(images.length > 0 || pastedTexts.length > 0 || children) && (
        <div className="flex flex-wrap gap-[6px]">
          {images.map((img, idx) => (
            <AgentImageItem
              key={img.id}
              id={img.id}
              filename={img.filename}
              url={img.url ?? ''}
              isLoading={img.isLoading}
              onRemove={() => onRemoveImage(img.id)}
              allImages={allImages}
              imageIndex={idx}
            />
          ))}
          {pastedTexts.map((pt) => (
            <AgentPastedTextItem
              key={pt.id}
              filePath={pt.filePath}
              filename={pt.filename}
              size={pt.size}
              preview={pt.preview}
              onRemove={() => onRemovePastedText(pt.id)}
            />
          ))}
          {children}
        </div>
      )}
    </div>
  );
}
