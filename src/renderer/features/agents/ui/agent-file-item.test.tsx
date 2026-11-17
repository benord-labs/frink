// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFileIconByExtension } from '@/lib/mentions/agents-file-mention-icons';
import { TooltipProvider } from '../../../components/ui/tooltip';
import { AgentDiffTextContextItem } from './agent-diff-text-context-item';
import { AgentFileItem } from './agent-file-item';
import { AgentPastedTextItem } from './agent-pasted-text-item';
import { AgentTextContextItem } from './agent-text-context-item';

afterEach(cleanup);

function iconMarkup(filename: string): string {
  const Icon = getFileIconByExtension(filename);
  return render(<Icon />).container.innerHTML;
}

function chipIcon(filename: string): string | undefined {
  return screen.getByText(filename).parentElement?.querySelector('svg')?.outerHTML;
}

describe('AgentFileItem', () => {
  it('draws each file with the icon for its file type', () => {
    render(
      <>
        <AgentFileItem filename="send.ts" />
        <AgentFileItem filename="package.json" />
      </>,
    );

    expect(chipIcon('send.ts')).toBe(iconMarkup('send.ts'));
    expect(chipIcon('package.json')).toBe(iconMarkup('package.json'));
    expect(chipIcon('send.ts')).not.toBe(chipIcon('package.json'));
  });

  it('shows the size after the name', () => {
    render(<AgentFileItem filename="notes.md" size={2048} />);

    expect(screen.getByText('notes.md').nextElementSibling).toHaveTextContent('2.0 KB');
  });

  it('shows the full path in the tooltip of the name', () => {
    render(
      <TooltipProvider>
        <AgentFileItem filename="send.ts" path="src/main/lib/send.ts" />
      </TooltipProvider>,
    );

    fireEvent.focus(screen.getByText('send.ts'));

    expect(screen.getByRole('tooltip')).toHaveTextContent('src/main/lib/send.ts');
  });

  it('keeps a named remove control on screen without hover', () => {
    const onRemove = vi.fn();
    render(<AgentFileItem filename="notes.md" onRemove={onRemove} />);

    const remove = screen.getByRole('button', { name: 'Remove notes.md' });
    expect(remove).toBeVisible();
    expect(remove.className).not.toContain('opacity-0');
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledOnce();
  });
});

describe('Text attachments in the composer strip', () => {
  it('draws selected, pasted and diff text as badges with named remove controls', () => {
    render(
      <TooltipProvider>
        <AgentTextContextItem
          text=""
          preview={'Keep the retry\nand the backoff'}
          onRemove={vi.fn()}
        />
        <AgentPastedTextItem
          filePath="/s/pasted/p.txt"
          filename="p.txt"
          size={2048}
          preview="Build a flow"
          onRemove={vi.fn()}
        />
        <AgentDiffTextContextItem
          text=""
          preview=""
          filePath="src/main/socket.ts"
          lineNumber={7}
          onRemove={vi.fn()}
        />
      </TooltipProvider>,
    );

    expect(screen.getByText('Keep the retry').previousElementSibling).toHaveClass(
      'lucide-square-dashed-text',
    );
    expect(screen.getByText('Build a flow').nextElementSibling).toHaveTextContent('2.0 KB');
    expect(screen.getByText('socket.ts').nextElementSibling).toHaveTextContent('L7');
    for (const name of [
      'Remove selected text',
      'Remove pasted text',
      'Remove selection from socket.ts',
    ]) {
      expect(screen.getByRole('button', { name }).className).not.toContain('opacity-0');
    }
  });

  it('shows a plan selection as text rather than as a file', () => {
    render(<AgentDiffTextContextItem text="" preview="" filePath="/repo/notes/plan.md" />);

    expect(screen.getByText('Plan').previousElementSibling).toHaveClass(
      'lucide-square-dashed-text',
    );
  });
});
