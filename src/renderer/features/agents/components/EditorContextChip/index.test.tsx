// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../../components/ui/tooltip';
import { EditorContextChip } from './index';

afterEach(cleanup);

const selection = {
  fileName: 'send.ts',
  filePath: '/repo/src/main/send.ts',
  startLine: 279,
  endLine: 282,
};

describe('EditorContextChip', () => {
  it('shows the attached file with a remove control that needs no hover', () => {
    const onRemoveFile = vi.fn();
    const onRemoveSelection = vi.fn();
    render(
      <EditorContextChip
        selection={null}
        fileName="notes.md"
        onRemoveSelection={onRemoveSelection}
        onRemoveFile={onRemoveFile}
      />,
    );

    expect(screen.getByText('notes.md')).toBeInTheDocument();
    const remove = screen.getByRole('button', { name: 'Remove notes.md from context' });
    expect(remove.className).not.toContain('opacity-0');
    expect(remove.className).not.toContain('sr-only');
    fireEvent.click(remove);
    expect(onRemoveFile).toHaveBeenCalledOnce();
    expect(onRemoveSelection).not.toHaveBeenCalled();
  });

  it('shows a selection with its line range and path in place of the file, and removes both together', () => {
    const onRemoveFile = vi.fn();
    const onRemoveSelection = vi.fn();
    render(
      <TooltipProvider>
        <EditorContextChip
          selection={selection}
          fileName="notes.md"
          onRemoveSelection={onRemoveSelection}
          onRemoveFile={onRemoveFile}
        />
      </TooltipProvider>,
    );

    fireEvent.focus(screen.getByText('send.ts'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('/repo/src/main/send.ts');
    expect(screen.getByText('L279-282')).toBeInTheDocument();
    expect(screen.queryByText('notes.md')).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove code selection and file from context: send.ts lines 279-282',
      }),
    );
    expect(onRemoveSelection).toHaveBeenCalledOnce();
    expect(onRemoveFile).toHaveBeenCalledOnce();
  });

  it('renders nothing when the editor adds nothing to the message', () => {
    const { container } = render(
      <EditorContextChip
        selection={null}
        fileName={null}
        onRemoveSelection={vi.fn()}
        onRemoveFile={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
