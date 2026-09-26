/**
 * Automatic Type Acquisition for Monaco Editor.
 * Uses @typescript/ata (official TypeScript package) to fetch type definitions
 * from jsdelivr CDN when imports are detected.
 *
 * This is the same ATA system used by the TypeScript Playground.
 * Dependencies are lazy-loaded to reduce initial bundle size.
 */

import type * as Monaco from 'monaco-editor';

let ataDispose: (() => void) | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastProcessedCode = '';

// Debounce delay for ATA (ms) - prevents excessive network requests
const ATA_DEBOUNCE_MS = 1500;

/**
 * Initialize Automatic Type Acquisition for a Monaco editor instance.
 * Call this once when the editor mounts.
 * Dependencies are lazy-loaded on first call.
 *
 * @param monaco - The Monaco module
 */
export async function initializeATA(monaco: typeof Monaco): Promise<void> {
  // Clean up existing instance if any
  if (ataDispose) {
    ataDispose();
    ataDispose = null;
  }

  // Lazy load heavy dependencies
  const [{ setupTypeAcquisition }, ts] = await Promise.all([
    import('@typescript/ata'),
    import('typescript').then((m) => m.default),
  ]);

  // Track added libs to avoid duplicates
  const addedLibs = new Set<string>();

  const ata = setupTypeAcquisition({
    projectName: 'frink-editor',
    typescript: ts,
    logger: {
      log: (_msg: string) => {},
      error: (_msg: string) => {},
      groupCollapsed: () => {},
      groupEnd: () => {},
    },
    delegate: {
      receivedFile: (code: string, path: string) => {
        // Avoid adding duplicates
        if (addedLibs.has(path)) return;
        addedLibs.add(path);

        // Add the type definition to Monaco
        const uri = `file://${path}`;
        monaco.typescript.typescriptDefaults.addExtraLib(code, uri);
        monaco.typescript.javascriptDefaults.addExtraLib(code, uri);
      },
      started: () => {},
      progress: (_downloaded: number, _total: number) => {},
      finished: (_vfs) => {},
    },
  });

  // Store the ATA function for later use
  (window as unknown as { __frinkATA: typeof ata }).__frinkATA = ata;

  // Create dispose function
  ataDispose = () => {
    delete (window as unknown as { __frinkATA?: typeof ata }).__frinkATA;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    lastProcessedCode = '';
  };
}

/**
 * Run ATA on the given source code to acquire types for imports.
 * Debounced to prevent excessive network requests.
 *
 * @param sourceCode - The TypeScript/JavaScript source code to analyze
 */
export function acquireTypes(sourceCode: string): void {
  const ata = (window as unknown as { __frinkATA?: (code: string) => void }).__frinkATA;
  if (!ata) return;

  // Clear existing timer
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  // Debounce ATA calls to prevent excessive network requests
  debounceTimer = setTimeout(() => {
    debounceTimer = null;

    // Skip if code hasn't changed significantly (only check imports)
    // This prevents re-processing on every keystroke
    const importLines = sourceCode.match(/^import\s+.+$/gm)?.join('\n') ?? '';
    if (importLines === lastProcessedCode) {
      return;
    }
    lastProcessedCode = importLines;

    ata(sourceCode);
  }, ATA_DEBOUNCE_MS);
}

/**
 * Dispose ATA instance.
 * Call this when editor unmounts.
 */
export function disposeATA(): void {
  if (ataDispose) {
    ataDispose();
    ataDispose = null;
  }
}
