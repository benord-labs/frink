// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImageFileRead } from '../../../../lib/code-editor/files/use-read-image-file';
import { AgentImageGenerationTool } from './index';

const readImage = vi.fn<(path: string) => ImageFileRead>();

afterEach(() => {
  cleanup();
  readImage.mockReset();
});

describe('AgentImageGenerationTool', () => {
  it('reserves the image space with a placeholder while the job runs', () => {
    // Upstream carries no prompt or path at item/started, so the pending state has to read as a
    // job in flight on its own: shimmering title + sweeping placeholder, no read issued.
    const { container } = render(
      <AgentImageGenerationTool
        part={{ type: 'tool-ImageGeneration', toolCallId: 'i1', state: 'input-available' }}
        chatStatus="streaming"
        useReadImage={readImage}
      />,
    );
    expect(screen.getByText('Generating image')).toBeDefined();
    expect(container.querySelector('[data-slot="image-placeholder"]')).not.toBeNull();
    expect(readImage).not.toHaveBeenCalled();
  });

  it('renders the saved file and opens it fullscreen on click', () => {
    readImage.mockReturnValue({ dataUrl: 'data:image/png;base64,AAAA' });
    render(
      <AgentImageGenerationTool
        part={{
          type: 'tool-ImageGeneration',
          toolCallId: 'i1',
          state: 'output-available',
          input: { prompt: 'a cozy tabby cat' },
          output: { path: '/tmp/cat.png' },
        }}
        chatStatus="ready"
        useReadImage={readImage}
      />,
    );
    expect(readImage).toHaveBeenCalledWith('/tmp/cat.png');
    const image = screen.getByRole('img', { name: 'a cozy tabby cat' });
    expect(image.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    fireEvent.click(image);
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('says the image was never saved instead of asking for a file that does not exist', () => {
    // A completed item can carry no savedPath when the provider's disk write failed; the transcript
    // keeps no bitmap, so this state is accepted lossy and must not issue a read for no path.
    render(
      <AgentImageGenerationTool
        part={{
          type: 'tool-ImageGeneration',
          toolCallId: 'i1',
          state: 'output-available',
          output: { path: null },
        }}
        chatStatus="ready"
        useReadImage={readImage}
      />,
    );
    expect(screen.getByText('Image was not saved to disk')).toBeDefined();
    expect(readImage).not.toHaveBeenCalled();
  });

  it('surfaces the read error verbatim when the file cannot be shown', () => {
    readImage.mockReturnValue({ error: { message: 'Image too large to display (max 8MB)' } });
    render(
      <AgentImageGenerationTool
        part={{
          type: 'tool-ImageGeneration',
          toolCallId: 'i1',
          state: 'output-available',
          output: { path: '/tmp/huge.png' },
        }}
        chatStatus="ready"
        useReadImage={readImage}
      />,
    );
    expect(screen.getByText('Image too large to display (max 8MB)')).toBeDefined();
  });

  it('shows the failure reason for a failed generation', () => {
    render(
      <AgentImageGenerationTool
        part={{
          type: 'tool-ImageGeneration',
          toolCallId: 'i1',
          state: 'output-error',
          errorText: 'Image generation limit reached',
        }}
        chatStatus="ready"
        useReadImage={readImage}
      />,
    );
    expect(screen.getByText('Image generation failed')).toBeDefined();
    expect(screen.getByText('Image generation limit reached')).toBeDefined();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('settles to an interrupted row when the turn ended before the item completed', () => {
    render(
      <AgentImageGenerationTool
        part={{ type: 'tool-ImageGeneration', toolCallId: 'i1', state: 'input-available' }}
        chatStatus="ready"
        useReadImage={readImage}
      />,
    );
    expect(screen.getByText('Image generation interrupted')).toBeDefined();
  });
});
