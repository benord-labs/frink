// Side-effect-only module: configures Monaco's worker/loader at import time, exports nothing.
import './monaco-loader-config';

export { acquireTypes, disposeATA, initializeATA } from './auto-typings';
export { getMonacoNavigationOptions } from './monaco-navigation-options';
export { configureMonacoForNodeScripts, limitTsDiagnosticsToSyntax } from './monaco-node-env';
export { clearProjectTypes, loadProjectTypes } from './project-types';
export { useMonacoTheme } from './use-monaco-theme';
