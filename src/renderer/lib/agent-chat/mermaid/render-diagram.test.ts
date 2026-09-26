// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { type DiagramTheme, readDiagramTheme } from './mermaid-config';
import {
  cachedDiagram,
  DiagramSourceError,
  type MermaidApi,
  renderDiagram,
} from './render-diagram';

function theme(accent: string): DiagramTheme {
  return {
    dark: true,
    background: 'hsl(0, 0%, 2%)',
    surface: 'hsl(0, 0%, 7.8%)',
    node: 'hsl(0, 0%, 15.7%)',
    nodeAlt: 'hsl(0, 0%, 12.2%)',
    text: 'hsl(0, 0%, 91%)',
    mutedText: 'hsl(0, 0%, 54.5%)',
    accent,
    border: 'hsl(0, 0%, 17.6%)',
    note: 'hsl(0, 0%, 10.2%)',
  };
}

function fakeMermaid(): MermaidApi {
  return {
    initialize: vi.fn(),
    parse: vi.fn(async () => ({ diagramType: 'flowchart', config: {} })),
    render: vi.fn(async (id: string, code: string) => ({
      svg: `<svg id="${id}">${code}</svg>`,
      diagramType: 'flowchart',
    })),
  };
}

describe('readDiagramTheme', () => {
  it('turns the theme vars on <html> into CSS colours', () => {
    const root = document.createElement('div');
    root.classList.add('dark');
    root.style.setProperty('--primary', '258 90% 76%');
    document.body.append(root);

    const read = readDiagramTheme(root);

    expect(read.dark).toBe(true);
    expect(read.accent).toBe('hsl(258, 90%, 76%)');
    root.remove();
  });
});

describe('renderDiagram', () => {
  it('paints with the theme and caches the SVG for that theme', async () => {
    const purple = theme('hsl(258, 90%, 76%)');
    const mermaid = fakeMermaid();
    const svg = await renderDiagram('graph TD; A-->B', purple, async () => mermaid);

    expect(svg).toContain('A-->B');
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: 'base',
        securityLevel: 'strict',
        suppressErrorRendering: true,
        themeVariables: expect.objectContaining({
          darkMode: true,
          primaryBorderColor: purple.accent,
          primaryTextColor: purple.text,
        }),
      }),
    );
    expect(cachedDiagram('graph TD; A-->B', purple)).toBe(svg);
  });

  it('serves a repeat from cache without calling Mermaid again', async () => {
    const blue = theme('hsl(228, 100%, 50%)');
    const mermaid = fakeMermaid();
    await renderDiagram('graph LR; X-->Y', blue, async () => mermaid);
    await renderDiagram('graph LR; X-->Y', blue, async () => mermaid);
    expect(mermaid.render).toHaveBeenCalledTimes(1);
  });

  it('redraws when the theme changes', async () => {
    await renderDiagram('graph LR; P-->Q', theme('hsl(258, 90%, 76%)'), async () => fakeMermaid());
    expect(cachedDiagram('graph LR; P-->Q', theme('hsl(0, 72%, 51%)'))).toBeUndefined();
  });

  it('reports source Mermaid cannot parse as a DiagramSourceError and caches nothing', async () => {
    const purple = theme('hsl(258, 90%, 76%)');
    const mermaid = fakeMermaid();
    vi.mocked(mermaid.parse).mockRejectedValueOnce(new Error('Parse error on line 1'));

    const drawing = renderDiagram('graph ??', purple, async () => mermaid);

    await expect(drawing).rejects.toBeInstanceOf(DiagramSourceError);
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(cachedDiagram('graph ??', purple)).toBeUndefined();
  });

  it('passes a drawing failure through as-is, even when its wording sounds like a syntax error', async () => {
    const purple = theme('hsl(258, 90%, 76%)');
    const mermaid = fakeMermaid();
    vi.mocked(mermaid.render).mockRejectedValueOnce(new SyntaxError("Unexpected token '<'"));

    const drawing = renderDiagram('graph TD; R1-->R2', purple, async () => mermaid);

    await expect(drawing).rejects.toThrow("Unexpected token '<'");
    await expect(drawing).rejects.not.toBeInstanceOf(DiagramSourceError);
  });

  it('never lets one theme leak into another render queued behind it', async () => {
    let configured = '';
    const mermaid: MermaidApi = {
      initialize: vi.fn((config) => {
        configured = config.themeVariables?.primaryBorderColor ?? '';
      }),
      parse: vi.fn(async () => ({ diagramType: 'flowchart', config: {} })),
      render: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { svg: `<svg data-accent="${configured}"></svg>`, diagramType: 'flowchart' };
      }),
    };
    const purple = theme('hsl(258, 90%, 76%)');
    const blue = theme('hsl(228, 100%, 50%)');

    const [first, second] = await Promise.all([
      renderDiagram('graph TD; Q1-->Q2', purple, async () => mermaid),
      renderDiagram('graph TD; Q3-->Q4', blue, async () => mermaid),
    ]);

    expect(first).toContain(purple.accent);
    expect(second).toContain(blue.accent);
  });
});
