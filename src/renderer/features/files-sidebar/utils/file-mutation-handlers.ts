import { toast } from 'sonner';

/** Result shape from files.copyExternalFiles (copied count + per-item errors). */
type CopyExternalFilesResult = {
  copied: number;
  skipped: number;
  renamed: number;
  errors: Array<{ path: string; message: string }>;
};

/**
 * Returns onSuccess and onError for trpc.files.copyExternalFiles.useMutation.
 * Invalidates file tree and shows toasts based on copied/errors. Use in both
 * FilesSidebar (index) and PaneFileTree so they share the same feedback.
 */
export function createCopyExternalFilesHandlers(invalidateTree: () => void): {
  onSuccess: (data: CopyExternalFilesResult) => void;
  onError: (err: unknown) => void;
} {
  return {
    onSuccess: (data) => {
      invalidateTree();
      if (data.copied > 0) {
        const renamedNote =
          data.renamed > 0 ? ` (${data.renamed} renamed to avoid overwriting)` : '';
        toast.success(`Added ${data.copied} item(s)${renamedNote}`);
        if (data.errors.length > 0) {
          toast.warning(`${data.errors.length} item(s) could not be added`);
        }
      } else if (data.errors.length > 0) {
        toast.error(data.errors[0]?.message ?? 'Failed to add files');
      }
    },
    onError: (err: unknown) => {
      const message =
        err &&
        typeof err === 'object' &&
        'message' in err &&
        typeof (err as { message: unknown }).message === 'string'
          ? (err as { message: string }).message
          : 'Failed to add files';
      toast.error(message);
    },
  };
}
