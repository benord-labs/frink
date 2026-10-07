// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunAttachment } from '../../../../../../shared/types/run-attachment';
import { decodedBytes } from '../../../../../../shared/utils/base64';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const trpcMocks = vi.hoisted(() => ({
  uploadMutateAsync: vi.fn(),
  removeMutate: vi.fn(),
  /** Default: idle preview query (no image loaded). */
  previewUseQuery: vi.fn(() => ({
    data: undefined as { dataUrl: string } | undefined,
    isLoading: false,
    isError: false,
  })),
}));

vi.mock('../../../../../lib/trpc', () => ({
  trpc: {
    flows: {
      uploadAndAttachImage: {
        useMutation: () => ({
          mutateAsync: trpcMocks.uploadMutateAsync,
        }),
      },
      updateStageRun: {
        useMutation: (_opts?: { onSuccess?: () => void }) => ({
          mutate: trpcMocks.removeMutate,
          isPending: false,
        }),
      },
      fetchAttachmentDataUrl: {
        useQuery: () => trpcMocks.previewUseQuery(),
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
  const fileInput = screen.getByLabelText('Upload image attachment') as HTMLInputElement;
  return { onAttachmentsChange, fileInput };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('RunAttachmentsSection', () => {
  beforeEach(() => {
    trpcMocks.uploadMutateAsync.mockReset();
    trpcMocks.uploadMutateAsync.mockResolvedValue({
      url: 'https://cdn.example.com/upload.png',
      filename: 'upload.png',
      run: { id: RUN_ID, trigger_context: {} },
    });
    trpcMocks.removeMutate.mockReset();
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
    it('shows size error and skips upload when file exceeds 5 MB', async () => {
      const { fileInput, onAttachmentsChange } = renderSection();

      // Create a real File whose size exceeds MAX_FILE_SIZE (5 * 1024 * 1024).
      const bigContent = new Uint8Array(6 * 1024 * 1024);
      const bigFile = new File([bigContent], 'big.png', { type: 'image/png' });

      fireEvent.change(fileInput, { target: { files: [bigFile] } });

      await waitFor(() => {
        expect(screen.getByText(/5MB or smaller/i)).toBeInTheDocument();
      });
      expect(trpcMocks.uploadMutateAsync).not.toHaveBeenCalled();
      expect(onAttachmentsChange).not.toHaveBeenCalled();
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

    it('reports file size in the error message', async () => {
      const { fileInput } = renderSection();

      const bigContent = new Uint8Array(6.3 * 1024 * 1024);
      const bigFile = new File([bigContent], 'big.png', { type: 'image/png' });

      fireEvent.change(fileInput, { target: { files: [bigFile] } });

      await waitFor(() => {
        // Should mention "6.3MB" (toFixed(1) formatting).
        expect(screen.getByText(/6\.3MB/)).toBeInTheDocument();
      });
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

    it('rejects an unsupported MIME type without calling the upload mutation', async () => {
      const { fileInput, onAttachmentsChange } = renderSection();

      const pdfFile = new File(['%PDF'], 'doc.pdf', { type: 'application/pdf' });

      fireEvent.change(fileInput, { target: { files: [pdfFile] } });

      await waitFor(() => {
        expect(screen.getByText(/Unsupported type/i)).toBeInTheDocument();
      });
      expect(trpcMocks.uploadMutateAsync).not.toHaveBeenCalled();
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
});
