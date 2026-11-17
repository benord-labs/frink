// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextItems } from './context-items';

afterEach(cleanup);

const nothingAttached = {
  images: [],
  pastedTexts: [],
  onRemoveImage: vi.fn(),
  onRemovePastedText: vi.fn(),
};

describe('ContextItems', () => {
  it('renders no strip, and so no gap above the editor, when nothing is attached', () => {
    const { container } = render(<ContextItems {...nothingAttached}>{null}</ContextItems>);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders the strip for an extra chip alone', () => {
    render(
      <ContextItems {...nothingAttached}>
        <span>notes.md</span>
      </ContextItems>,
    );

    expect(screen.getByText('notes.md')).toBeInTheDocument();
  });

  it('puts the extra chip after the images and pasted text, in one wrapping row', () => {
    const { container } = render(
      <ContextItems
        {...nothingAttached}
        images={[
          { id: 'img-1', filename: 'screenshot.png', url: 'blob:shot', isLoading: false },
          { id: 'img-2', filename: 'uploading.png', url: null, isLoading: true },
        ]}
        pastedTexts={[
          {
            id: 'paste-1',
            filePath: '/sessions/s/pasted/paste-1.txt',
            filename: 'paste-1.txt',
            size: 6000,
            preview: 'Build a cron-triggered flow',
          },
        ]}
      >
        <span data-testid="editor-chip">notes.md</span>
      </ContextItems>,
    );

    const row = container.querySelector('.flex-wrap');
    expect(row).not.toBeNull();
    expect(row?.children).toHaveLength(4);
    expect(row?.lastElementChild).toBe(screen.getByTestId('editor-chip'));
  });
});
