import type { Mermaid } from 'mermaid';
import { type DiagramTheme, mermaidConfig } from './mermaid-config';

export type MermaidApi = Pick<Mermaid, 'initialize' | 'parse' | 'render'>;

/** Mermaid could not read the source: the diagram's code is wrong, so retrying cannot help. */
export class DiagramSourceError extends Error {
  override name = 'DiagramSourceError';
}

let mermaidApi: Promise<MermaidApi> | undefined;
let renderCount = 0;
// initialize() sets global config, so each initialize + render pair runs alone.
let renderQueue: Promise<void> = Promise.resolve();

// Rendered SVGs survive remounts (virtualised chat rows, tab switches) for the session.
const svgCache = new Map<string, string>();

// Mermaid is ~500KB, so it loads on the first diagram rather than with the chat bundle.
// A failed load is forgotten so the next attempt fetches again.
function loadMermaid(): Promise<MermaidApi> {
  mermaidApi ??= import('mermaid').then(
    (module) => module.default,
    (error: Error) => {
      mermaidApi = undefined;
      throw error;
    },
  );
  return mermaidApi;
}

function cacheKey(code: string, theme: DiagramTheme): string {
  return `${Object.values(theme).join(',')}\n${code}`;
}

/** The SVG already drawn for this source in this theme, if any. */
export function cachedDiagram(code: string, theme: DiagramTheme): string | undefined {
  return svgCache.get(cacheKey(code, theme));
}

/**
 * Draws `code` as an SVG string in the theme's colours. Rejects with `DiagramSourceError` when
 * the source does not parse, or with the underlying error when loading or drawing fails.
 */
export async function renderDiagram(
  code: string,
  theme: DiagramTheme,
  load: () => Promise<MermaidApi> = loadMermaid,
): Promise<string> {
  const key = cacheKey(code, theme);
  const cached = svgCache.get(key);
  if (cached) return cached;

  const mermaid = await load();
  const run = renderQueue.then(async () => {
    mermaid.initialize(mermaidConfig(theme));
    await mermaid.parse(code).catch((error: Error) => {
      throw new DiagramSourceError(error.message, { cause: error });
    });
    renderCount += 1;
    const { svg } = await mermaid.render(`frink-mermaid-${renderCount}`, code);
    return svg;
  });
  renderQueue = run.then(
    () => undefined,
    () => undefined,
  );
  const svg = await run;
  svgCache.set(key, svg);
  return svg;
}
