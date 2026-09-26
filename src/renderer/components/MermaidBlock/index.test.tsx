// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DiagramTheme, readDiagramTheme } from '@/lib/agent-chat/mermaid/mermaid-config';
import { renderDiagram } from '@/lib/agent-chat/mermaid/render-diagram';
import { MermaidBlock } from '.';

// Frink's dark globals.css values for the vars a diagram reads.
const THEME_VARS = {
  '--background': '0 0% 2%',
  '--card': '0 0% 7.8%',
  '--secondary': '0 0% 15.7%',
  '--accent': '0 0% 12.2%',
  '--foreground': '0 0% 91%',
  '--muted-foreground': '0 0% 54.5%',
  '--primary': '258 90% 76%',
  '--border': '0 0% 17.6%',
  '--muted': '0 0% 10.2%',
};
const FLOW = 'flowchart TD\n  A[Start] --> B[Finish]';
// Passes the streaming "looks complete" check, then fails Mermaid's own parse.
const NOT_A_DIAGRAM = 'this is not a diagram of anything';
// The first real Mermaid import is slow under happy-dom.
const MERMAID_WAIT = { timeout: 10_000 };

function renderBlock(code: string, isStreaming = false) {
  return render(<MermaidBlock code={code} isStreaming={isStreaming} />);
}

async function seedDrawnDiagram(
  code: string,
  testId = 'diagram',
  theme: DiagramTheme = readDiagramTheme(),
): Promise<void> {
  await renderDiagram(code, theme, async () => ({
    initialize: vi.fn(),
    parse: vi.fn(async () => ({ diagramType: 'flowchart', config: {} })),
    render: vi.fn(async () => ({
      svg: `<svg data-testid="${testId}"></svg>`,
      diagramType: 'flowchart',
    })),
  }));
}

beforeEach(() => {
  const root = document.documentElement;
  root.classList.add('dark');
  for (const [name, value] of Object.entries(THEME_VARS)) root.style.setProperty(name, value);
});

afterEach(cleanup);

describe('MermaidBlock', () => {
  it('shows a drawn diagram and opens the zoomable viewer', async () => {
    await seedDrawnDiagram(FLOW);
    renderBlock(FLOW);

    expect(screen.getByTestId('diagram')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand diagram' })[1]);
    expect(screen.getByRole('dialog')).toHaveTextContent('Diagram');
    expect(screen.getByRole('button', { name: 'Download as SVG' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('hides the previous drawing as soon as completed source is replaced', async () => {
    const first = `${FLOW}\n  B --> C[First]`;
    await seedDrawnDiagram(first, 'first-diagram');
    const { rerender } = renderBlock(first);
    expect(screen.getByTestId('first-diagram')).toBeInTheDocument();

    rerender(<MermaidBlock code={`${FLOW}\n  B --> C[Second]`} />);

    expect(screen.queryByTestId('first-diagram')).not.toBeInTheDocument();
    expect(screen.getByText('Drawing diagram…')).toBeInTheDocument();
  });

  it('redraws when the theme changes without a light/dark switch', async () => {
    const code = `${FLOW}\n  B --> C[Themed]`;
    await seedDrawnDiagram(code, 'violet-diagram');
    renderBlock(code);
    expect(screen.getByTestId('violet-diagram')).toBeInTheDocument();

    await seedDrawnDiagram(code, 'green-diagram', {
      ...readDiagramTheme(),
      accent: 'hsl(160, 84%, 39%)',
    });
    await act(async () => {
      document.documentElement.style.setProperty('--primary', '160 84% 39%');
    });

    expect(await screen.findByTestId('green-diagram')).toBeInTheDocument();
  });

  it('keeps drawing while streamed source is half-written or not yet parseable', async () => {
    renderBlock(NOT_A_DIAGRAM, true);
    // Longer than the streaming debounce plus a real Mermaid parse.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(screen.getByText('Drawing diagram…')).toBeInTheDocument();
    expect(screen.queryByText("This diagram couldn't be drawn")).not.toBeInTheDocument();
  }, 10_000);

  it('explains a broken diagram in plain words once the reply is done', async () => {
    renderBlock(NOT_A_DIAGRAM);

    expect(
      await screen.findByText("This diagram couldn't be drawn", undefined, MERMAID_WAIT),
    ).toBeInTheDocument();
    expect(screen.getByText(/No diagram type detected/)).toBeInTheDocument();
    expect(screen.getByText(/Ask the agent to fix the diagram/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Expand diagram' })).not.toBeInTheDocument();
  }, 15_000);

  it('draws streamed source as soon as Mermaid can parse it, whatever its last character', async () => {
    renderBlock(`${FLOW}\n  %% notes may end in a colon:`, true);

    expect(
      await screen.findAllByRole('button', { name: 'Expand diagram' }, MERMAID_WAIT),
    ).toHaveLength(2);
  }, 15_000);

  it('drops an earlier error once new half-written source starts streaming', async () => {
    const { rerender } = renderBlock(NOT_A_DIAGRAM);
    await screen.findByText("This diagram couldn't be drawn", undefined, MERMAID_WAIT);

    rerender(<MermaidBlock code={'flowchart TD\n  A[Sta'} isStreaming />);

    expect(screen.getByText('Drawing diagram…')).toBeInTheDocument();
    expect(screen.queryByText("This diagram couldn't be drawn")).not.toBeInTheDocument();
  }, 15_000);

  it('offers a retry when drawing fails for a reason other than invalid code', async () => {
    // happy-dom has no layout engine, so Mermaid parses a sequence diagram but fails to draw it.
    renderBlock('sequenceDiagram\n  Alice->>Bob: Hello');

    expect(
      await screen.findByText(
        'Something went wrong while drawing it. Try again.',
        undefined,
        MERMAID_WAIT,
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Drawing diagram…')).toBeInTheDocument();
  }, 15_000);

  it('copies the diagram source', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    renderBlock(FLOW);

    fireEvent.click(screen.getByRole('button', { name: 'Copy diagram code' }));

    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(FLOW);
  });
});
