// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PASTED_FILE_TOO_LARGE } from '../../../../../../shared/pasted-file-limits';
import type { RunAttachment } from '../../../../../../shared/types/run-attachment';
import { decodedBytes } from '../../../../../../shared/utils/base64';

// ── Mocks ──────────────────────────────────────────────────────────────────────

type RemoveInput = { flowId: string; runId: string; url: string };
type RemoveCallbacks = { onError?: (err: Error) => void };
type PreviewInput = { url: string };
type PreviewOptions = { enabled?: boolean };

const trpcMocks = vi.hoisted(() => ({
  uploadMutateAsync: vi.fn(),
  attachFileMutateAsync: vi.fn(),
  removeMutate: vi.fn<(input: RemoveInput, callbacks?: RemoveCallbacks) => void>(),
  invalidateRunList: vi.fn(),
  /** Default: idle preview query (no image loaded). */
  previewUseQuery: vi.fn((_input?: PreviewInput, _opts?: PreviewOptions) => ({
    data: undefined as { dataUrl: string } | undefined,
    isLoading: false,
    isError: false,
  })),
}));

vi.mock('../../../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      flows: { listBatchStageRuns: { invalidate: trpcMocks.invalidateRunList } },
    }),
    flows: {
      uploadAndAttachImage: {
        useMutation: () => ({
          mutateAsync: trpcMocks.uploadMutateAsync,
        }),
      },
      attachFileToRun: {
        useMutation: () => ({ mutateAsync: trpcMocks.attachFileMutateAsync }),
      },
      removeStageRunAttachment: {
        useMutation: (_opts?: { onSuccess?: () => void }) => ({
          mutate: trpcMocks.removeMutate,
          isPending: false,
        }),
      },
      fetchAttachmentDataUrl: {
        useQuery: (input: PreviewInput, opts?: PreviewOptions) =>
          trpcMocks.previewUseQuery(input, opts),
      },
    },
  },
}));

// ── Component under test ───────────────────────────────────────────────────────

const { RunAttachmentsSection } = await import('./RunAttachmentsSection');

// ── Helpers ────────────────────────────────────────────────────────────────────

const FLOW_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
/** 8-byte PNG header — just enough to pass magic-byte validation. */
const pngMagicBytes = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** 3-byte JPEG header */
const jpegMagicBytes = () => new Uint8Array([0xff, 0xd8, 0xff]);

function renderSection(attachments: RunAttachment[] = [], isPending = true) {
  const onAttachmentsChange = vi.fn();
  render(
    <RunAttachmentsSection
      flowId={FLOW_ID}
      runId={RUN_ID}
      attachments={attachments}
      isPending={isPending}
      onAttachmentsChange={onAttachmentsChange}
    />,
  );
  const fileInput = screen.getByLabelText('Upload file attachment') as HTMLInputElement;
  return { onAttachmentsChange, fileInput };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('RunAttachmentsSection', () => {
  beforeEach(() => {
    trpcMocks.uploadMutateAsync.mockReset();
    trpcMocks.uploadMutateAsync.mockResolvedValue({
      url: 'https://cdn.example.com/upload.png',
      filename: 'upload.png',
      attachment: {
        url: 'https://cdn.example.com/upload.png',
        type: 'image/png',
        label: 'upload.png',
      },
      run: { id: RUN_ID, trigger_context: {} },
    });
    trpcMocks.attachFileMutateAsync.mockReset();
    trpcMocks.attachFileMutateAsync.mockResolvedValue({
      attachment: {
        url: 'frink-attachment://run/a1-report.csv',
        type: 'file',
        label: 'report.csv',
      },
      run: { id: RUN_ID, trigger_context: {} },
    });
    window.webUtils = { getPathForFile: (file) => `/Users/me/${file.name}` };
    trpcMocks.removeMutate.mockReset();
    trpcMocks.invalidateRunList.mockReset();
    trpcMocks.previewUseQuery.mockReset();
    trpcMocks.previewUseQuery.mockImplementation(() => ({
      data: undefined,
      isLoading: false,
      isError: false,
    }));
  });

  afterEach(() => {
    cleanup();
  });

  describe('client-side size guard', () => {
    it('sends an image over 5 MB by its path instead of inline', async () => {
      const { fileInput } = renderSection();

      const bigFile = new File([new Uint8Array(6 * 1024 * 1024)], 'big.png', {
        type: 'image/png',
      });
      fireEvent.change(fileInput, { target: { files: [bigFile] } });

      await waitFor(() => {
        expect(trpcMocks.attachFileMutateAsync).toHaveBeenCalledWith({
          flowId: FLOW_ID,
          runId: RUN_ID,
          sourcePath: '/Users/me/big.png',
        });
      });
      expect(trpcMocks.uploadMutateAsync).not.toHaveBeenCalled();
    });

    // The server accepts exactly 5MB of decoded bytes, so the client must send it — as raw
    // padded base64 whose decoded size is the file size, not a data URL.
    it('uploads a file of exactly 5 MB as raw base64', async () => {
      let data = '';
      trpcMocks.uploadMutateAsync.mockImplementationOnce(async (input: { data: string }) => {
        data = input.data;
        return {
          url: 'frink-attachment://run/edge.png',
          filename: 'edge.png',
          attachment: {
            url: 'frink-attachment://run/edge.png',
            type: 'image/png',
            label: 'edge.png',
          },
          run: { id: RUN_ID },
        };
      });
      const { fileInput } = renderSection();

      const size = 5 * 1024 * 1024;
      const file = new File([new Uint8Array(size)], 'edge.png', { type: 'image/png' });
      fireEvent.change(fileInput, { target: { files: [file] } });

      await waitFor(() => {
        expect(trpcMocks.uploadMutateAsync).toHaveBeenCalledTimes(1);
      });
      expect(data.startsWith('data:')).toBe(false);
      expect(decodedBytes(data)).toBe(size);
      expect(screen.queryByText(/5MB or smaller/i)).not.toBeInTheDocument();
    });

    it('names the 5MB limit for a large image that has no file behind it', async () => {
      window.webUtils = { getPathForFile: () => '' };
      const { fileInput } = renderSection();

      const shot = new File([new Uint8Array(6.3 * 1024 * 1024)], 'image.png', {
        type: 'image/png',
      });
      fireEvent.change(fileInput, { target: { files: [shot] } });

      await waitFor(() => {
        expect(screen.getByText(/5MB or smaller \(this file is 6\.3MB\)/)).toBeInTheDocument();
      });
      expect(trpcMocks.attachFileMutateAsync).not.toHaveBeenCalled();
    });

    it('refuses a file over 20 MB without sending it', async () => {
      const { fileInput, onAttachmentsChange } = renderSection();

      const bigFile = new File(['x'], 'huge.csv', { type: 'text/csv' });
      Object.defineProperty(bigFile, 'size', { value: 21 * 1024 * 1024 });
      fireEvent.change(fileInput, { target: { files: [bigFile] } });

      await waitFor(() => {
        expect(screen.getByText(PASTED_FILE_TOO_LARGE)).toBeInTheDocument();
      });
      expect(trpcMocks.attachFileMutateAsync).not.toHaveBeenCalled();
      expect(onAttachmentsChange).not.toHaveBeenCalled();
    });
  });

  describe('MIME type normalisation', () => {
    it('normalises image/jpg to image/jpeg in the upload mutation payload', async () => {
      const { fileInput } = renderSection();

      // JPEG magic bytes with non-standard type 'image/jpg'
      const jpgFile = new File([jpegMagicBytes()], 'photo.jpg', { type: 'image/jpg' });

      fireEvent.change(fileInput, { target: { files: [jpgFile] } });

      await waitFor(() => {
        expect(trpcMocks.uploadMutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({ mimeType: 'image/jpeg' }),
        );
      });
    });

    // Windows gives a .csv no type at all; it must still be attached, by path.
    it('attaches a file with no type by its path and lists what the server stored', async () => {
      const { fileInput, onAttachmentsChange } = renderSection();

      fireEvent.change(fileInput, { target: { files: [new File(['a,b'], 'report.csv')] } });

      await waitFor(() => {
        expect(onAttachmentsChange).toHaveBeenCalledWith([
          { url: 'frink-attachment://run/a1-report.csv', type: 'file', label: 'report.csv' },
        ]);
      });
      expect(trpcMocks.attachFileMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ sourcePath: '/Users/me/report.csv' }),
      );
      expect(trpcMocks.uploadMutateAsync).not.toHaveBeenCalled();
    });

    it('explains a file with no place on disk instead of sending it', async () => {
      window.webUtils = { getPathForFile: () => '' };
      const { fileInput, onAttachmentsChange } = renderSection();

      const pdfFile = new File(['%PDF'], 'doc.pdf', { type: 'application/pdf' });
      fireEvent.change(fileInput, { target: { files: [pdfFile] } });

      await waitFor(() => {
        expect(screen.getByText(/Save it to your computer/)).toBeInTheDocument();
      });
      expect(trpcMocks.attachFileMutateAsync).not.toHaveBeenCalled();
      expect(onAttachmentsChange).not.toHaveBeenCalled();
    });
  });

  describe('error propagation from server', () => {
    it('displays the server error message when the upload mutation rejects', async () => {
      trpcMocks.uploadMutateAsync.mockRejectedValueOnce(
        new Error('Run has started and images can no longer be added'),
      );
      const { fileInput } = renderSection();

      const pngFile = new File([pngMagicBytes()], 'test.png', { type: 'image/png' });
      fireEvent.change(fileInput, { target: { files: [pngFile] } });

      await waitFor(() => {
        expect(screen.getByText(/run has started/i)).toBeInTheDocument();
      });
    });

    it('displays a generic "Upload failed" fallback when the error has no message', async () => {
      // Reject with a non-Error (e.g., a plain string from network layer).
      trpcMocks.uploadMutateAsync.mockRejectedValueOnce('network error');
      const { fileInput } = renderSection();

      const pngFile = new File([pngMagicBytes()], 'test.png', { type: 'image/png' });
      fireEvent.change(fileInput, { target: { files: [pngFile] } });

      await waitFor(() => {
        expect(screen.getByText(/upload failed/i)).toBeInTheDocument();
      });
    });
  });

  describe('attachment preview', () => {
    it('enables a labelled preview control when the data URL is loaded', () => {
      trpcMocks.previewUseQuery.mockReturnValue({
        data: { dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
        isLoading: false,
        isError: false,
      });
      const attachment: RunAttachment = {
        url: 'frink-attachment://run-1/shot.png',
        type: 'image/png',
        label: 'shot.png',
        mimeType: 'image/png',
      };
      renderSection([attachment]);
      expect(screen.getByRole('button', { name: /Preview shot\.png/i })).toBeEnabled();
    });

    // A file row has no thumbnail; loading one would pull the whole file over IPC.
    it('never loads a preview for a file the agent reads by path', () => {
      renderSection([
        { url: 'frink-attachment://run-1/a1-report.csv', type: 'file', label: 'report.csv' },
      ]);

      expect(trpcMocks.previewUseQuery).toHaveBeenCalledWith(
        { url: 'frink-attachment://run-1/a1-report.csv' },
        expect.objectContaining({ enabled: false }),
      );
    });

    it('keeps preview disabled when fetchAttachmentDataUrl fails', () => {
      trpcMocks.previewUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        isError: true,
      });
      const attachment: RunAttachment = {
        url: 'frink-attachment://run-1/shot.png',
        type: 'image/png',
        label: 'shot.png',
        mimeType: 'image/png',
      };
      renderSection([attachment]);
      expect(screen.getByRole('button', { name: /Preview shot\.png/i })).toBeDisabled();
    });
  });

  describe('multi-file upload', () => {
    it('invokes upload once per file when several files are selected', async () => {
      const { fileInput } = renderSection();

      const f1 = new File([pngMagicBytes()], 'a.png', { type: 'image/png' });
      const f2 = new File([pngMagicBytes()], 'b.png', { type: 'image/png' });
      const f3 = new File([pngMagicBytes()], 'c.png', { type: 'image/png' });

      fireEvent.change(fileInput, { target: { files: [f1, f2, f3] } });

      await waitFor(() => {
        expect(trpcMocks.uploadMutateAsync).toHaveBeenCalledTimes(3);
      });
    });

    it('truncates multi-file selection to remaining slots and surfaces max-attachments error', async () => {
      const nine: RunAttachment[] = Array.from({ length: 9 }, (_, i) => ({
        url: `https://cdn.example.com/img${i}.png`,
        type: 'image/png',
        label: `img${i}.png`,
        mimeType: 'image/png',
      }));
      const { fileInput } = renderSection(nine);

      const f1 = new File([pngMagicBytes()], 'a.png', { type: 'image/png' });
      const f2 = new File([pngMagicBytes()], 'b.png', { type: 'image/png' });
      const f3 = new File([pngMagicBytes()], 'c.png', { type: 'image/png' });

      fireEvent.change(fileInput, { target: { files: [f1, f2, f3] } });

      await waitFor(() => {
        expect(trpcMocks.uploadMutateAsync).toHaveBeenCalledTimes(1);
        expect(screen.getByText(/Maximum 10/i)).toBeInTheDocument();
      });
    });

    it('appends skipped-files hint when truncation applies and the attempted upload fails', async () => {
      trpcMocks.uploadMutateAsync.mockRejectedValueOnce(new Error('Server rejected upload'));
      const nine: RunAttachment[] = Array.from({ length: 9 }, (_, i) => ({
        url: `https://cdn.example.com/img${i}.png`,
        type: 'image/png',
        label: `img${i}.png`,
        mimeType: 'image/png',
      }));
      const { fileInput } = renderSection(nine);

      const f1 = new File([pngMagicBytes()], 'a.png', { type: 'image/png' });
      const f2 = new File([pngMagicBytes()], 'b.png', { type: 'image/png' });
      const f3 = new File([pngMagicBytes()], 'c.png', { type: 'image/png' });

      fireEvent.change(fileInput, { target: { files: [f1, f2, f3] } });

      await waitFor(() => {
        expect(screen.getByText(/server rejected upload/i)).toBeInTheDocument();
        expect(screen.getByText(/Additional files were skipped/i)).toBeInTheDocument();
      });
    });
  });

  describe('attachment capacity guard', () => {
    it('blocks upload when already at MAX_ATTACHMENTS (10)', async () => {
      const fullAttachments: RunAttachment[] = Array.from({ length: 10 }, (_, i) => ({
        url: `https://cdn.example.com/img${i}.png`,
        type: 'image/png',
        label: `img${i}.png`,
        mimeType: 'image/png',
      }));
      const { fileInput, onAttachmentsChange } = renderSection(fullAttachments);

      const pngFile = new File([pngMagicBytes()], 'extra.png', { type: 'image/png' });
      fireEvent.change(fileInput, { target: { files: [pngFile] } });

      await waitFor(() => {
        expect(screen.getByText(/Maximum 10/i)).toBeInTheDocument();
      });
      expect(trpcMocks.uploadMutateAsync).not.toHaveBeenCalled();
      expect(onAttachmentsChange).not.toHaveBeenCalled();
    });
  });
  describe('removing an attachment', () => {
    const att = (n: number): RunAttachment => ({
      url: `frink-attachment://${RUN_ID}/0000000${n}-${n}.png`,
      type: 'image/png',
      label: `${n}.png`,
    });

    it('names the attachment by URL instead of sending the remaining list', () => {
      const { onAttachmentsChange } = renderSection([att(1), att(2)]);

      fireEvent.click(screen.getByLabelText('Remove 1.png'));

      expect(trpcMocks.removeMutate).toHaveBeenCalledWith(
        { flowId: FLOW_ID, runId: RUN_ID, url: att(1).url },
        expect.anything(),
      );
      expect(onAttachmentsChange).toHaveBeenLastCalledWith([att(2)]);
    });

    it('puts back only the removed attachment when the server refuses', () => {
      const { onAttachmentsChange } = renderSection([att(1), att(2)]);

      fireEvent.click(screen.getByLabelText('Remove 1.png'));
      const callbacks = trpcMocks.removeMutate.mock.calls[0]?.[1];
      act(() =>
        callbacks?.onError?.(new Error('Images can only be removed before the run starts')),
      );

      expect(onAttachmentsChange).toHaveBeenLastCalledWith([att(2), att(1)]);
      expect(
        screen.getByText('Images can only be removed before the run starts'),
      ).toBeInTheDocument();
    });

    // Catches: a failed removal restoring the list it saw before, which drops an upload
    // that finished while the removal was in flight.
    it('keeps an upload that finished while a failed removal was in flight', async () => {
      const uploaded = att(3);
      trpcMocks.uploadMutateAsync.mockResolvedValueOnce({
        url: uploaded.url,
        filename: '3.png',
        attachment: uploaded,
        run: { id: RUN_ID, trigger_context: {} },
      });
      function StatefulParent() {
        const [list, setList] = useState<RunAttachment[]>([att(1), att(2)]);
        return (
          <RunAttachmentsSection
            flowId={FLOW_ID}
            runId={RUN_ID}
            attachments={list}
            isPending
            onAttachmentsChange={setList}
          />
        );
      }
      render(<StatefulParent />);

      fireEvent.click(screen.getByLabelText('Remove 1.png'));
      const file = new File([pngMagicBytes()], '3.png', { type: 'image/png' });
      fireEvent.change(screen.getByLabelText('Upload file attachment'), {
        target: { files: [file] },
      });
      await screen.findByLabelText('Remove 3.png');
      const callbacks = trpcMocks.removeMutate.mock.calls[0]?.[1];
      act(() => callbacks?.onError?.(new Error('offline')));

      for (const label of ['1.png', '2.png', '3.png']) {
        expect(screen.getByLabelText(`Remove ${label}`)).toBeInTheDocument();
      }
    });

    it('does not list an upload twice when its URL is already shown', async () => {
      trpcMocks.uploadMutateAsync.mockResolvedValueOnce({
        url: att(1).url,
        filename: '1.png',
        attachment: att(1),
        run: { id: RUN_ID, trigger_context: {} },
      });
      const { onAttachmentsChange, fileInput } = renderSection([att(1)]);

      const file = new File([pngMagicBytes()], '1.png', { type: 'image/png' });
      fireEvent.change(fileInput, { target: { files: [file] } });

      await waitFor(() => expect(trpcMocks.uploadMutateAsync).toHaveBeenCalledOnce());
      expect(onAttachmentsChange).not.toHaveBeenCalled();
    });
  });
});
