/* eslint-disable max-lines, max-lines-per-function */
/**
 * Image attachments panel for a batch stage run.
 * Supports drag-and-drop, clipboard paste, and file picker.
 * Uploads images atomically (validate + upload blob + save in one request) via tRPC.
 * Removing attachments uses a targeted PATCH on trigger_context.attachments.
 * Only editable when run status === 'pending'.
 * To reference external URLs (Figma, docs, etc.), add them to Custom Instructions instead.
 */

import { Button } from '@benord-labs/frink-primitives';
import { ImageIcon, Loader2, X } from 'lucide-react';
import { type ClipboardEvent, type DragEvent, type ReactElement, useRef, useState } from 'react';
import type { RunAttachment } from '../../../../../../shared/types/run-attachment';
import { Dialog, DialogContent, DialogTitle } from '../../../../../components/ui/dialog';
import { trpc } from '../../../../../lib/trpc';
import { cn } from '../../../../../lib/utils';

const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_ATTACHMENTS = 10;
/** Mirror of server-side MAX_IMAGE_BYTES — 5MB decoded limit. */
const MAX_FILE_SIZE = 5 * 1024 * 1024;

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1] ?? '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

type UploadingItem = {
  id: string;
  label: string;
};

type Props = {
  flowId: string;
  runId: string;
  attachments: RunAttachment[];
  isPending: boolean;
  onAttachmentsChange: (next: RunAttachment[]) => void;
};

export function RunAttachmentsSection({
  flowId,
  runId,
  attachments,
  isPending,
  onAttachmentsChange,
}: Props): ReactElement {
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadingItems, setUploadingItems] = useState<UploadingItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Ref always reflects the latest committed list so async upload loops see
  // the growing list rather than the stale closure from the first render.
  const attachmentsRef = useRef<RunAttachment[]>(attachments);
  attachmentsRef.current = attachments;

  const uploadAndAttachImage = trpc.flows.uploadAndAttachImage.useMutation();
  const removeRun = trpc.flows.updateStageRun.useMutation({
    onSuccess: () => setError(null),
  });

  const canAdd = isPending && attachments.length + uploadingItems.length < MAX_ATTACHMENTS;

  /** Caps a file list to remaining slots. Caller sets max-attachments error after uploads if `truncated`. */
  function takeFilesWithinAttachmentLimit(files: File[]): { files: File[]; truncated: boolean } {
    const available = Math.max(
      0,
      MAX_ATTACHMENTS - attachmentsRef.current.length - uploadingItems.length,
    );
    const taken = files.slice(0, available);
    return { files: taken, truncated: taken.length < files.length };
  }

  /** After a multi-file batch: show max-attachments warning, or append if uploads failed too. */
  function applyTruncationFeedbackAfterBatch(truncated: boolean, anyUploadFailed: boolean) {
    if (!truncated) return;
    if (!anyUploadFailed) {
      setError(`Maximum ${MAX_ATTACHMENTS} attachments per run.`);
      return;
    }
    setError((prev) =>
      prev
        ? `${prev} Additional files were skipped (max ${MAX_ATTACHMENTS} attachments per run).`
        : `Maximum ${MAX_ATTACHMENTS} attachments per run.`,
    );
  }

  function removeAttachment(index: number) {
    const next = attachmentsRef.current.filter((_, i) => i !== index);
    const prev = attachmentsRef.current;
    attachmentsRef.current = next;
    onAttachmentsChange(next);
    removeRun.mutate(
      { flowId, runId, attachments: next },
      {
        onError: (err) => {
          attachmentsRef.current = prev;
          onAttachmentsChange(prev);
          setError(err.message);
        },
      },
    );
  }

  /** Returns true only when the file was uploaded and attached successfully. */
  async function uploadFile(file: File): Promise<boolean> {
    // Normalize image/jpg (non-standard) to image/jpeg before any checks.
    const normalizedType = file.type === 'image/jpg' ? 'image/jpeg' : file.type;

    if (!ALLOWED_MIME_TYPES.includes(normalizedType)) {
      setError(`Unsupported type: ${file.type}. Use PNG, JPEG, or WebP.`);
      return false;
    }
    if (file.size > MAX_FILE_SIZE) {
      setError(
        `Image must be 5MB or smaller (this file is ${(file.size / 1024 / 1024).toFixed(1)}MB).`,
      );
      return false;
    }
    if (attachmentsRef.current.length + uploadingItems.length >= MAX_ATTACHMENTS) {
      setError(`Maximum ${MAX_ATTACHMENTS} attachments per run.`);
      return false;
    }

    const itemId = crypto.randomUUID();
    setUploadingItems((prev) => [...prev, { id: itemId, label: file.name }]);
    setError(null);

    try {
      const base64Data = await fileToBase64(file);
      const result = await uploadAndAttachImage.mutateAsync({
        flowId,
        runId,
        data: base64Data,
        filename: file.name,
        mimeType: normalizedType,
      });
      const next: RunAttachment[] = [
        ...attachmentsRef.current,
        { url: result.url, type: normalizedType, label: file.name, mimeType: normalizedType },
      ];
      attachmentsRef.current = next;
      onAttachmentsChange(next);
      setError(null);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      return false;
    } finally {
      setUploadingItems((prev) => prev.filter((i) => i.id !== itemId));
    }
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    if (!canAdd) return;
    e.preventDefault();
    setIsDragOver(true);
  }

  function handleDragLeave() {
    setIsDragOver(false);
  }

  async function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    if (!canAdd) return;
    const { files, truncated } = takeFilesWithinAttachmentLimit(Array.from(e.dataTransfer.files));
    if (files.length === 0) {
      if (truncated) {
        setError(`Maximum ${MAX_ATTACHMENTS} attachments per run.`);
      }
      return;
    }
    const outcomes = await Promise.all(files.map((file) => uploadFile(file)));
    const anyUploadFailed = outcomes.some((ok) => !ok);
    applyTruncationFeedbackAfterBatch(truncated, anyUploadFailed);
  }

  async function handlePaste(e: ClipboardEvent<HTMLDivElement>) {
    if (!canAdd) return;
    const fromClipboard: File[] = [];
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) fromClipboard.push(file);
      }
    }
    const { files, truncated } = takeFilesWithinAttachmentLimit(fromClipboard);
    if (files.length === 0) {
      if (truncated) {
        setError(`Maximum ${MAX_ATTACHMENTS} attachments per run.`);
      }
      return;
    }
    const outcomes = await Promise.all(files.map((file) => uploadFile(file)));
    const anyUploadFailed = outcomes.some((ok) => !ok);
    applyTruncationFeedbackAfterBatch(truncated, anyUploadFailed);
  }

  async function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const { files, truncated } = takeFilesWithinAttachmentLimit(Array.from(e.target.files ?? []));
    if (files.length === 0) {
      if (truncated) {
        setError(`Maximum ${MAX_ATTACHMENTS} attachments per run.`);
      }
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    const outcomes = await Promise.all(files.map((file) => uploadFile(file)));
    const anyUploadFailed = outcomes.some((ok) => !ok);
    applyTruncationFeedbackAfterBatch(truncated, anyUploadFailed);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wide">
          Images
        </span>
        {removeRun.isPending && (
          <span className="text-[10px] text-muted-foreground/40 italic">Saving…</span>
        )}
        {error && (
          <span
            className="text-[10px] text-destructive/70 italic truncate max-w-[140px]"
            title={error}
          >
            {error}
          </span>
        )}
      </div>

      {/* Existing + in-progress attachments */}
      {(attachments.length > 0 || uploadingItems.length > 0) && (
        <div className="flex flex-col gap-1">
          {attachments.map((a, i) => (
            <AttachmentRow
              key={`${a.url}__${a.type}`}
              attachment={a}
              isPending={isPending}
              onRemove={() => removeAttachment(i)}
            />
          ))}
          {uploadingItems.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-2 rounded border border-border/40 bg-muted/20 px-2 py-1.5"
            >
              <Loader2
                className="h-3 w-3 text-muted-foreground/50 shrink-0 animate-spin"
                aria-hidden
              />
              <span className="text-[11px] text-muted-foreground/60 truncate flex-1">
                {item.label}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Drop zone (pending only) */}
      {isPending && (
        <div
          role="button"
          tabIndex={0}
          aria-label="Add image — drop, paste, or click"
          className={cn(
            'rounded border border-dashed border-border/50 px-3 py-3 text-center transition-colors cursor-pointer focus:outline-hidden focus-visible:ring-1 focus-visible:ring-primary/40',
            isDragOver
              ? 'border-primary/50 bg-primary/5'
              : 'hover:border-border/80 hover:bg-muted/20',
            !canAdd && 'opacity-40 pointer-events-none',
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onPaste={handlePaste}
          onClick={() => canAdd && fileInputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
          }}
        >
          <ImageIcon className="h-3.5 w-3.5 text-muted-foreground/40 mx-auto mb-1" aria-hidden />
          <span className="text-[10px] text-muted-foreground/50">
            {canAdd ? 'Drop, paste, or click to add image' : `Max ${MAX_ATTACHMENTS} images`}
          </span>
          <input
            ref={fileInputRef}
            type="file"
            accept={ALLOWED_MIME_TYPES.join(',')}
            multiple
            className="hidden"
            onChange={handleFileInputChange}
            aria-label="Upload image attachment"
          />
        </div>
      )}

      {/* Read-only empty state */}
      {!isPending && attachments.length === 0 && (
        <span className="text-[11px] text-muted-foreground/40">No images attached</span>
      )}
    </div>
  );
}

type AttachmentRowProps = {
  attachment: RunAttachment;
  isPending: boolean;
  onRemove: () => void;
};

function AttachmentRow({ attachment, isPending, onRemove }: AttachmentRowProps): ReactElement {
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const displayLabel =
    attachment.label ??
    (() => {
      try {
        return new URL(attachment.url).pathname.split('/').pop() ?? attachment.url;
      } catch {
        return attachment.url;
      }
    })();

  const { data, isLoading, isError } = trpc.flows.fetchAttachmentDataUrl.useQuery(
    { url: attachment.url },
    { staleTime: 5 * 60_000, retry: 1 },
  );

  return (
    <>
      <div className="flex items-center gap-2 rounded border border-border/40 bg-muted/20 px-2 py-1.5 group">
        <Button
          variant="ghost"
          size="sm"
          disabled={!data?.dataUrl}
          onClick={() => data?.dataUrl && setLightboxOpen(true)}
          className={cn(
            'shrink-0 w-7 h-7 rounded overflow-hidden bg-muted/40',
            data?.dataUrl && 'cursor-zoom-in hover:opacity-80 transition-opacity',
          )}
          aria-label={`Preview ${displayLabel}`}
          iconOnly
        >
          {isLoading && (
            <Loader2 className="h-3 w-3 text-muted-foreground/40 animate-spin" aria-hidden />
          )}
          {isError && <ImageIcon className="h-3 w-3 text-muted-foreground/30" aria-hidden />}
          {data?.dataUrl && (
            <img
              src={data.dataUrl}
              alt=""
              className="w-full h-full object-cover"
              draggable={false}
            />
          )}
        </Button>
        <span className="text-[11px] text-foreground/70 truncate flex-1" title={displayLabel}>
          {displayLabel}
        </span>
        {isPending && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onRemove}
            className="shrink-0 text-muted-foreground/40 opacity-0 hover:text-foreground/60 group-hover:opacity-100 transition-opacity"
            aria-label={`Remove ${displayLabel}`}
          >
            <X className="h-3 w-3" aria-hidden />
          </Button>
        )}
      </div>

      {data?.dataUrl && (
        <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
          <DialogContent
            glass={false}
            className="max-w-[90vw] max-h-[90vh] p-0 overflow-hidden bg-black/90 border-border/30"
          >
            <DialogTitle className="sr-only">{displayLabel}</DialogTitle>
            <img
              src={data.dataUrl}
              alt={displayLabel}
              className="w-full h-full object-contain max-h-[90vh]"
              draggable={false}
            />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
