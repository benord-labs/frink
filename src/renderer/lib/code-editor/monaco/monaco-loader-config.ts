/**
 * Configure Monaco to load from the bundled monaco-editor package instead of CDN.
 * Run once at app init so the editor works fully offline.
 *
 * @see https://github.com/suren-atoyan/monaco-react#use-monaco-editor-as-an-npm-package
 */

import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
// Vite bundles these as separate worker chunks so they work offline
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import cssWorker from 'monaco-editor/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/language/html/html.worker?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import { configureMonacoForNodeScripts, disableBuiltinTsDiagnostics } from './monaco-node-env';

const getWorker = (_id: string, label: string): Worker => {
  switch (label) {
    case 'json':
      return new jsonWorker();
    case 'css':
    case 'scss':
    case 'less':
      return new cssWorker();
    case 'html':
    case 'handlebars':
    case 'razor':
      return new htmlWorker();
    case 'typescript':
    case 'javascript':
      return new tsWorker();
    default:
      return new editorWorker();
  }
};

const selfWithMonaco = self as Window & {
  // biome-ignore lint/style/useNamingConvention: Monaco global API property name
  MonacoEnvironment?: { getWorker: (id: string, label: string) => Worker };
};
selfWithMonaco.MonacoEnvironment = { getWorker };
loader.config({ monaco });

// CRITICAL: Disable built-in TS/JS diagnostics IMMEDIATELY at app startup
// Monaco's sandboxed worker can't access node_modules, causing false errors
disableBuiltinTsDiagnostics(monaco as Parameters<typeof disableBuiltinTsDiagnostics>[0]);
configureMonacoForNodeScripts(monaco);
