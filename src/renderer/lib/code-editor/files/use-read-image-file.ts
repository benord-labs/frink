import { trpc } from '../../trpc';

export type ImageFileRead = {
  dataUrl?: string;
  error?: { message: string };
};

/** Read an on-disk image as a data URL. Injected into image cards so their tests need no module mock. */
export function useReadImageFile(path: string): ImageFileRead {
  const { data, error } = trpc.files.readImageFile.useQuery(
    { filePath: path },
    { staleTime: Number.POSITIVE_INFINITY, retry: false },
  );
  return { dataUrl: data?.dataUrl, error: error ?? undefined };
}

export type ReadImageFile = typeof useReadImageFile;
