/**
 * Ambient declarations for Node/Electron globals so Monaco's TypeScript
 * language service doesn't report errors in preload and main scripts.
 */

/**
 * Ambient declarations for Node/Electron globals so Monaco's TypeScript
 * language service doesn't report errors in preload and main scripts.
 */
const NODE_ELECTRON_EXTRA_LIB = `
declare const process: {
  env: Record<string, string | undefined>;
  platform: string;
  arch: string;
};

declare const __dirname: string;
declare const __filename: string;

declare module 'electron' {
  export const contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => void;
  };
  export const ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on: (channel: string, handler: (...args: unknown[]) => void) => void;
    removeListener: (channel: string, handler: (...args: unknown[]) => void) => void;
  };
}
`;

/** Minimal type for Monaco's TS defaults (avoids importing full monaco-editor). */
type MonacoTsDefaults = {
  addExtraLib(content: string, filePath?: string): unknown;
  setCompilerOptions(options: Record<string, unknown>): void;
  setDiagnosticsOptions(options: {
    noSemanticValidation?: boolean;
    noSyntaxValidation?: boolean;
    noSuggestionDiagnostics?: boolean;
    diagnosticCodesToIgnore?: number[];
  }): void;
  setEagerModelSync(value: boolean): void;
};

type MonacoForTs = {
  typescript: {
    typescriptDefaults: MonacoTsDefaults;
    javascriptDefaults: MonacoTsDefaults;
  };
};

let configured = false;

/**
 * Configure Monaco's TypeScript worker with Node/Electron globals and JSX support.
 * Idempotent: safe to call multiple times.
 */
export function configureMonacoForNodeScripts(monaco: MonacoForTs): void {
  if (configured) return;
  const ts = monaco.typescript.typescriptDefaults;
  const js = monaco.typescript.javascriptDefaults;
  ts.addExtraLib(NODE_ELECTRON_EXTRA_LIB, 'node-electron-globals.d.ts');
  js.addExtraLib(NODE_ELECTRON_EXTRA_LIB, 'node-electron-globals.d.ts');

  // Configure compiler options with JSX support
  const compilerOpts = {
    target: 99, // ESNext
    module: 99, // ESNext
    moduleResolution: 2, // NodeJs
    jsx: 4, // react-jsx (React 17+)
    jsxImportSource: 'react',
    allowNonTsExtensions: true,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    esModuleInterop: true,
    strict: false, // Disable strict to reduce false positives
    skipLibCheck: true,
  };
  ts.setCompilerOptions(compilerOpts);
  js.setCompilerOptions(compilerOpts);
  configured = true;
}

/**
 * Show only syntax errors from Monaco's built-in TypeScript worker.
 * MUST be called in beforeMount BEFORE Monaco processes any files.
 * Semantic errors stay off: the sandboxed worker can't read node_modules or the
 * project tsconfig, so imports and types would be flagged falsely.
 *
 * IMPORTANT: We keep setEagerModelSync(true) to preserve type inference,
 * hover info, and intellisense.
 */
export function limitTsDiagnosticsToSyntax(monaco: MonacoForTs): void {
  const ts = monaco.typescript.typescriptDefaults;
  const js = monaco.typescript.javascriptDefaults;

  const diagnosticOptions = {
    noSemanticValidation: true,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: true,
    // Ignore common false positive error codes as additional fallback
    diagnosticCodesToIgnore: [
      2307, // Cannot find module
      2304, // Cannot find name
      2322, // Type not assignable
      2339, // Property does not exist
      2345, // Argument type not assignable
      2551, // Property does not exist, did you mean
      2552, // Cannot find name, did you mean
      2554, // Expected N arguments
      2556, // Spread argument
      2686, // UMD global
      2792, // Cannot find module, did you mean to set moduleResolution
      7016, // Could not find declaration file
      7031, // Binding element implicitly has any
    ],
  };

  ts.setDiagnosticsOptions(diagnosticOptions);
  js.setDiagnosticsOptions(diagnosticOptions);

  // KEEP eager model sync enabled for type inference and hover info
  ts.setEagerModelSync(true);
  js.setEagerModelSync(true);
}
