// ESLint config — scoped narrowly to the project-structure plugin (folder
// hierarchy + file naming + import walls + file/function size). oxlint handles
// all code/style/lint rules; this config is purely structural.
//
// Why ESLint: oxlint cannot validate folder structure (no path primitives, no
// cross-file checks). The project-structure plugin is purpose-built for it and
// gives real-time IDE feedback.
//
// The 6 structureRoots, rule shapes and the renderer⊅main trust wall are the
// process-boundary contract; the lib/ domain registries live in eslint/domains.mjs.
// Legacy violators are grandfathered in eslint/baselines/*.mjs (shrink-only).

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tsParser from '@typescript-eslint/parser';
import {
  createFolderStructure,
  createIndependentModules,
  projectStructureParser,
  projectStructurePlugin,
} from 'eslint-plugin-project-structure';
import { MAIN_LIB_DOMAINS, RENDERER_LIB_DOMAINS } from './eslint/domains.mjs';
import { noRawSurfaceFill } from './eslint/no-raw-surface-fill.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Load a named export from eslint/baselines/<file>, or [] when the file is absent.
async function loadBaseline(file, exportName) {
  const path = join(HERE, 'eslint', 'baselines', file);
  if (!existsSync(path)) return [];
  const mod = await import(pathToFileURL(path).href);
  return mod[exportName] ?? [];
}

const [
  rendererStructureBaseline,
  mainStructureBaseline,
  sharedStructureBaseline,
  preloadStructureBaseline,
  rendererImportWallBaseline,
  rendererStructureExempt,
  mainStructureExempt,
  importWallExempt,
] = await Promise.all([
  loadBaseline('renderer.mjs', 'rendererStructureBaseline'),
  loadBaseline('main.mjs', 'mainStructureBaseline'),
  loadBaseline('shared.mjs', 'sharedStructureBaseline'),
  loadBaseline('preload.mjs', 'preloadStructureBaseline'),
  loadBaseline('imports.mjs', 'rendererImportWallBaseline'),
  loadBaseline('exempt.mjs', 'rendererStructureExempt'),
  loadBaseline('exempt.mjs', 'mainStructureExempt'),
  loadBaseline('exempt.mjs', 'importWallExempt'),
]);

const regex = {
  PascalCase: '^[A-Z][a-zA-Z0-9]*$',
  kebab_case: '^[a-z][a-z0-9-]*$',
  use_hook: '^use-[a-z][a-z0-9-]*\\.tsx?$',
  use_hook_pascal: '^use[A-Z][a-zA-Z0-9]*$',
  use_hook_camel: '^use[A-Z][a-zA-Z0-9]*\\.tsx?$',
  test_file: '^.+\\.(test|spec)\\.tsx?$',
  kebab_ts: '^[a-z][a-z0-9-]*\\.ts$',
  kebab_tsx: '^[a-z][a-z0-9-]*\\.tsx$',
  // `.compiled` marks a test that vitest runs through the React Compiler (vitest.config.ts).
  kebab_test: '^[a-z][a-z0-9-]*(\\.compiled)?\\.(test|spec)\\.tsx?$',
  any_file: '^.+$',
  any_css: '^.+\\.css$',
};

// STRICT component folder rule — PascalCase folder MUST contain index.tsx and may
// contain only: index.tsx (required), constants.ts, types.ts, css, colocated
// tests, recursive child folders, __tests__/.
const componentFolderRule = {
  name: '{PascalCase}',
  enforceExistence: 'index.tsx',
  children: [
    { name: 'index.tsx' },
    { name: 'index.ts' },
    { name: 'constants.ts' },
    { name: 'types.ts' },
    { name: '{test_file}' },
    { name: '{any_css}' },
    {
      name: '__tests__',
      children: [
        { name: '{test_file}' },
        { name: '__snapshots__', children: [{ name: '{any_file}' }] },
      ],
    },
    { ruleId: 'componentFolder' },
    { ruleId: 'groupingFolder' },
  ],
};

// Feature folder rule — kebab-case feature module wrapping PascalCase component
// folders: features/<kebab>/<Pascal>/index.tsx. UI-only: NO loose logic files
// ({kebab_ts} deliberately absent) — logic lives in lib/ (or hooks/).
const featureFolderRule = {
  name: '{kebab_case}',
  children: [
    { name: 'index.ts' },
    { name: 'index.tsx' },
    { name: 'constants.ts' },
    { ruleId: 'componentFolder' },
    { ruleId: 'groupingFolder' },
  ],
};

// UI GROUPING folder — a kebab sub-area inside a feature, a component folder, or
// components/ that ORGANISES component folders (e.g. agents/main, active-chat/components,
// dialogs/settings-tabs). Holds component folders + nested groups + barrels/constants/
// types/tests/css — but NO loose logic ({kebab_ts} deliberately absent): logic still lives
// in lib/. Flat-dumps are independently prevented by the folder fan-out cap (<=12/folder),
// so grouping no longer risks the original "flat logic dump" concern. Recursive.
const groupingFolderRule = {
  name: '{kebab_case}',
  children: [
    { name: 'index.ts' },
    { name: 'index.tsx' },
    { name: 'constants.ts' },
    { name: 'types.ts' },
    { name: '{test_file}' },
    { name: '{any_css}' },
    {
      name: '__tests__',
      children: [
        { name: '{test_file}' },
        { name: '__snapshots__', children: [{ name: '{any_file}' }] },
      ],
    },
    { ruleId: 'componentFolder' },
    { ruleId: 'groupingFolder' },
  ],
};

// General RECURSIVE kebab-module rule for src/renderer/lib. NO enforceExistence
// (index.ts allowed, not required). ONE rule governs every lib subfolder.
const libKebabFolderRule = {
  name: '{kebab_case}',
  children: [
    { name: 'index.ts' },
    { name: 'index.tsx' },
    { name: 'constants.ts' },
    { name: 'types.ts' },
    { name: '{kebab_ts}' },
    { name: '{kebab_tsx}' },
    { name: '{kebab_test}' },
    { name: '{use_hook}' },
    { name: '{any_css}' },
    {
      name: '__tests__',
      children: [
        { name: '{kebab_test}' },
        { name: '__snapshots__', children: [{ name: '{any_file}' }] },
      ],
    },
    { ruleId: 'libKebabFolder' },
  ],
};

const folderStructure = createFolderStructure({
  regexParameters: {
    ...regex,
    // Closed domain vocabulary for first-level lib/ folders — see eslint/domains.mjs.
    // Empty registry => a regex that matches NOTHING, so every lib folder is
    // "unregistered". That is SAFE because the baseline generator grandfathers
    // every existing lib file at init time; new lib folders then need a domain.
    lib_domain: RENDERER_LIB_DOMAINS.length ? `^(${RENDERER_LIB_DOMAINS.join('|')})$` : '^$',
    // Seals the frozen legacy dirs (matches nothing).
    frozen_dir_migrate_to_lib: '^$',
  },
  structureRoot: 'src/renderer',
  ignorePatterns: [
    'assets/**',
    'public/**',
    'styles/**',
    'components/ui/**',
    'icons/**',
    ...rendererStructureBaseline,
    ...rendererStructureExempt,
  ],
  structure: {
    name: 'renderer',
    children: [
      { name: 'App.tsx' },
      { name: 'main.tsx' },
      { name: 'wdyr.ts' },
      { name: 'index.html' },
      {
        name: 'components',
        children: [{ ruleId: 'componentFolder' }, { ruleId: 'groupingFolder' }],
      },
      { name: 'features', children: [{ ruleId: 'featureFolder' }] },
      {
        name: 'hooks',
        children: [
          { name: '{use_hook}' },
          { name: '{use_hook_camel}' },
          { name: '{test_file}' },
          {
            name: '{use_hook_pascal}',
            children: [{ name: 'index.ts' }, { name: 'index.tsx' }, { name: '{test_file}' }],
          },
        ],
      },
      {
        name: 'lib',
        children: [
          { name: 'index.ts' },
          { name: '{lib_domain}', children: libKebabFolderRule.children },
        ],
      },
      { name: 'contexts', children: [{ name: '{frozen_dir_migrate_to_lib}' }] },
      { name: 'constants', children: [{ name: '{frozen_dir_migrate_to_lib}' }] },
      { name: 'types', children: [{ name: '{frozen_dir_migrate_to_lib}' }] },
      { name: 'utils', children: [{ name: '{frozen_dir_migrate_to_lib}' }] },
      { name: 'icons', children: [{ name: '{any_file}' }, { ruleId: 'componentFolder' }] },
      { name: 'styles', children: [{ name: '{any_file}' }, { ruleId: 'componentFolder' }] },
      { name: 'assets', children: [{ name: '{any_file}' }, { ruleId: 'componentFolder' }] },
      { name: 'public', children: [{ name: '{any_file}' }, { ruleId: 'componentFolder' }] },
    ],
  },
  rules: {
    componentFolder: componentFolderRule,
    featureFolder: featureFolderRule,
    groupingFolder: groupingFolderRule,
    libKebabFolder: libKebabFolderRule,
  },
});

// ─── src/main/ structure ────────────────────────────────────────────────────
// Electron main process — pure Node, no React. Module-as-folder pattern: every
// folder is a module with index.ts as its public API.
const mainKebabFolderRule = {
  name: '{kebab_case}',
  enforceExistence: 'index.ts',
  children: [
    { name: 'index.ts' },
    { name: 'constants.ts' },
    { name: '{kebab_ts}' },
    { name: '{kebab_test}' },
    {
      name: '__tests__',
      children: [
        { name: '{kebab_test}' },
        { name: '__snapshots__', children: [{ name: '{any_file}' }] },
      ],
    },
    { ruleId: 'mainKebabFolder' },
  ],
};

const mainStructure = createFolderStructure({
  regexParameters: {
    ...regex,
    kebab_ts: '^[a-z][a-z0-9-]*\\.ts$',
    kebab_test: '^[a-z][a-z0-9-]*\\.(test|spec)\\.ts$',
    main_lib_domain: MAIN_LIB_DOMAINS.length ? `^(${MAIN_LIB_DOMAINS.join('|')})$` : '^$',
  },
  structureRoot: 'src/main',
  ignorePatterns: [...mainStructureBaseline, ...mainStructureExempt],
  structure: {
    name: 'main',
    enforceExistence: 'index.ts',
    children: [
      { name: 'index.ts' },
      { name: 'constants.ts' },
      {
        name: 'lib',
        children: [
          { name: 'index.ts' },
          {
            name: '{main_lib_domain}',
            enforceExistence: 'index.ts',
            children: mainKebabFolderRule.children,
          },
        ],
      },
      { name: 'windows', enforceExistence: 'index.ts', children: mainKebabFolderRule.children },
    ],
  },
  rules: { mainKebabFolder: mainKebabFolderRule },
});

// ─── src/shared/ structure ───────────────────────────────────────────────────
// PROCESS-AGNOSTIC code imported by BOTH main and renderer. Recursive kebab
// modules; index.ts OPTIONAL (mostly leaf types/helpers).
const sharedKebabFolderRule = {
  name: '{kebab_case}',
  children: [
    { name: 'index.ts' },
    { name: 'constants.ts' },
    { name: 'types.ts' },
    { name: '{kebab_ts}' },
    { name: '{kebab_test}' },
    {
      name: '__tests__',
      children: [
        { name: '{kebab_test}' },
        { name: '__snapshots__', children: [{ name: '{any_file}' }] },
      ],
    },
    { ruleId: 'sharedKebabFolder' },
  ],
};

const sharedStructure = createFolderStructure({
  regexParameters: {
    ...regex,
    kebab_ts: '^[a-z][a-z0-9-]*\\.ts$',
    kebab_test: '^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*\\.(test|spec)\\.ts$',
  },
  structureRoot: 'src/shared',
  ignorePatterns: [...sharedStructureBaseline],
  structure: {
    name: 'shared',
    children: [
      { name: 'index.ts' },
      { name: 'constants.ts' },
      { name: '{kebab_ts}' },
      { name: '{kebab_test}' },
      { ruleId: 'sharedKebabFolder' },
    ],
  },
  rules: { sharedKebabFolder: sharedKebabFolderRule },
});

// ─── src/preload/ structure ──────────────────────────────────────────────────
// TRUSTED contextBridge — the ONLY renderer↔main surface. FLAT files.
const preloadStructure = createFolderStructure({
  regexParameters: {
    ...regex,
    kebab_ts: '^[a-z][a-z0-9-]*\\.ts$',
    kebab_test: '^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*\\.(test|spec)\\.ts$',
  },
  structureRoot: 'src/preload',
  ignorePatterns: [...preloadStructureBaseline],
  structure: {
    name: 'preload',
    children: [
      { name: 'index.ts' },
      { name: 'index.d.ts' },
      { name: 'constants.ts' },
      { name: '{kebab_ts}' },
      { name: '{kebab_test}' },
      { name: '__tests__', children: [{ name: '{kebab_test}' }] },
    ],
  },
});

// ─── relay/src structure ─────────────────────────────────────────────────────
// The public webhook forwarder: one flat entry file plus its test, so no lib domain registry.
const relayStructure = createFolderStructure({
  regexParameters: {
    ...regex,
    kebab_test: '^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*\\.(test|spec)\\.ts$',
  },
  structureRoot: 'relay/src',
  structure: {
    name: 'src',
    children: [{ name: 'index.ts' }, { name: '{kebab_test}' }],
  },
});

// ─── Backend processes (which to structure-lint) ────────────────────────────
const backends = { relay: true };

const backendConfigs = [
  ...(backends.relay
    ? [
        {
          files: ['relay/src/**/*.ts', 'relay/src/*'],
          plugins: { 'project-structure': projectStructurePlugin },
          languageOptions: { parser: projectStructureParser },
          rules: { 'project-structure/folder-structure': ['error', relayStructure] },
        },
      ]
    : []),
];

// ─── Import walls (independent-modules) ─────────────────────────────────────
// Trust-boundary + cross-feature + frozen-dir consumption walls. Path-RESOLVING
// (relative + '@/' alias resolve to root-relative before matching).

const importWalls = createIndependentModules({
  pathAliases: { baseUrl: '.', paths: { '@/*': ['src/renderer/*'] } },
  debugMode: false,
  reusableImportPatterns: {
    renderer_base: [
      [
        'src/renderer/**',
        '!**/../**',
        '!src/renderer/features/*/**',
        '!src/renderer/utils/**',
        '!src/renderer/types/**',
        '!src/renderer/constants/**',
        '!src/renderer/contexts/**',
      ],
      'src/renderer/features/*/index.ts',
      'src/renderer/features/*/index.tsx',
      '{family_4}/**',
      'src/shared/**',
      '**?worker',
      '**?raw',
      '**?url',
      'virtual:**',
    ],
  },
  modules: [
    // FIRST MATCH WINS — order is load-bearing:
    // 1. Hand-maintained permanent exemptions (reason-required, never shrink).
    ...importWallExempt,
    // 2. Per-file grandfathers (shrink-only).
    ...rendererImportWallBaseline,
    // 3. The walls.
    {
      name: 'renderer',
      pattern: 'src/renderer/**',
      errorMessage:
        'Renderer import wall: no src/main (cross-process types -> src/shared/types), no other-feature deep paths (use the @/features/<x> barrel), no frozen legacy dirs (@/utils,@/types,@/constants,@/contexts -> lib/). Grandfathered files: eslint/baselines/imports.mjs (shrink-only).',
      allowImportsFrom: ['{renderer_base}'],
    },
    {
      name: 'shared',
      pattern: 'src/shared/**',
      errorMessage:
        'src/shared is process-agnostic: it may only import src/shared (+ externals) — never main/renderer/preload.',
      allowImportsFrom: ['src/shared/**'],
    },
  ],
});

// Stub plugin factory: registers rule names so legacy inline disable comments
// validate. Each rule is a no-op.
const stubRule = { meta: { schema: [], messages: {} }, create: () => ({}) };
const legacyDisableStub = (ruleNames) => ({
  rules: Object.fromEntries(ruleNames.map((n) => [n, stubRule])),
});

export default [
  // Never lint build output / generated artifacts (gitignored).
  { ignores: ['**/dist/**', '**/out/**', '**/*.tsbuildinfo'] },
  {
    files: ['src/renderer/**/*.{ts,tsx,css}', 'src/renderer/*'],
    plugins: { 'project-structure': projectStructurePlugin },
    languageOptions: { parser: projectStructureParser },
    rules: { 'project-structure/folder-structure': ['error', folderStructure] },
  },
  {
    files: ['src/main/**/*.ts', 'src/main/*'],
    plugins: { 'project-structure': projectStructurePlugin },
    languageOptions: { parser: projectStructureParser },
    rules: { 'project-structure/folder-structure': ['error', mainStructure] },
  },
  {
    files: ['src/shared/**/*.ts', 'src/shared/*'],
    plugins: { 'project-structure': projectStructurePlugin },
    languageOptions: { parser: projectStructureParser },
    rules: { 'project-structure/folder-structure': ['error', sharedStructure] },
  },
  {
    files: ['src/preload/**/*.ts', 'src/preload/*'],
    plugins: { 'project-structure': projectStructurePlugin },
    languageOptions: { parser: projectStructureParser },
    rules: { 'project-structure/folder-structure': ['error', preloadStructure] },
  },
  // Backend-process structure rules — active per `backends` (see above).
  ...backendConfigs,
  // Import walls. Tests are wall-free.
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'src/shared/**/*.ts'],
    ignores: ['**/*.{test,spec}.{ts,tsx}', '**/__tests__/**'],
    plugins: { 'project-structure': projectStructurePlugin },
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
    },
    rules: { 'project-structure/independent-modules': ['error', importWalls] },
  },
  // relay/ and live-activity-forwarder/ install their own node_modules, which a resolving import
  // wall would need on every lint run.
  {
    files: ['relay/src/**/*.ts', 'live-activity-forwarder/src/**/*.ts'],
    ignores: ['**/*.{test,spec}.ts'],
    languageOptions: { parser: tsParser, parserOptions: { sourceType: 'module' } },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../**', 'src/**', '@/**'],
              message:
                'relay/ and live-activity-forwarder/ are standalone public packages: they may only import their own src (+ externals) — never src/.',
            },
          ],
        },
      ],
    },
  },
  // Flow-run transitions are synchronous commands (flows/transitions/index.ts): they may use the
  // admission store, never the controller, runtime or drain, whose methods await.
  {
    files: ['src/main/lib/flows/transitions/**/*.ts'],
    ignores: ['**/*.{test,spec}.ts'],
    languageOptions: { parser: tsParser, parserOptions: { sourceType: 'module' } },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(^|/)admission(/(index|controller|runtime|drain))?$',
              message:
                'A transition must stay synchronous: import admission store functions, not the controller, runtime or drain.',
            },
          ],
        },
      ],
    },
  },
  // Node-builtin ban for the renderer (browser context). Bare `path` is
  // DELIBERATELY absent — vite aliases it to path-browserify for the renderer.
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    ignores: ['**/*.{test,spec}.{ts,tsx}', '**/__tests__/**'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                'node:*/**',
                'fs',
                'fs/**',
                'os',
                'child_process',
                'crypto',
                'net',
                'tls',
                'http',
                'https',
                'stream',
                'stream/**',
                'util',
                'events',
                'url',
                'zlib',
                'worker_threads',
                'readline',
                'dns',
                'dgram',
                'tty',
                'v8',
                'vm',
                'module',
                'process',
                'buffer',
                'assert',
                'async_hooks',
                'perf_hooks',
                'querystring',
                'string_decoder',
                'timers',
                'timers/**',
              ],
              message:
                'Renderer is a browser context: no Node builtins (type the contract in src/shared instead). For path ops use `import path from "path"` — vite aliases it to path-browserify.',
            },
          ],
        },
      ],
    },
  },
  // Bare solid surface fills (frink/no-raw-surface-fill), outside the areas that stay solid.
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    ignores: [
      '**/*.{test,spec}.{ts,tsx}',
      '**/__tests__/**',
      // The flow canvas and its nodes stay solid.
      'src/renderer/features/flows/FlowEditor/FlowCanvas/**',
      'src/renderer/features/flows/FlowEditor/FlowRunHistoryPanel/BatchReportPanel/BatchPlanCanvas/**',
      'src/renderer/features/flows/FlowEditor/BatchMonitor/BatchDagCanvas/**',
      // A hollow timeline dot sits on the rail and must hide it.
      'src/renderer/features/flows/FlowChangeArtifact/FlowChangeOutline/index.tsx',
      // The selected thumb of a segmented control on a muted track.
      'src/renderer/features/flows/FlowEditor/FlowEditorHeader/index.tsx',
      // Overlapping empty-state tiles: each hides the one behind it.
      'src/renderer/features/flows/FlowsList/index.tsx',
    ],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
    },
    plugins: { frink: { rules: { 'no-raw-surface-fill': noRawSurfaceFill } } },
    rules: { 'frink/no-raw-surface-fill': 'error' },
  },
  // File-size + function-size limits. Source = 500/file + 200/function. Tests =
  // 2000/file (loose). Stub plugins register rule names for legacy inline disables.
  {
    files: [
      'src/**/*.{ts,tsx}',
      'relay/src/**/*.ts',
      'live-activity-forwarder/src/**/*.ts',
      'mobile/**/*.{ts,tsx}',
    ],
    ignores: ['**/*.{test,spec}.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
    },
    plugins: {
      'react-hooks': legacyDisableStub(['exhaustive-deps', 'rules-of-hooks']),
      '@typescript-eslint': legacyDisableStub([
        'no-require-imports',
        'consistent-type-imports',
        'only-throw-error',
      ]),
      'jsx-a11y': legacyDisableStub(['no-autofocus']),
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'max-lines': ['error', { max: 500, skipBlankLines: false, skipComments: false }],
      'max-lines-per-function': [
        'error',
        { max: 200, skipBlankLines: false, skipComments: false, IIFEs: true },
      ],
    },
  },
  {
    // React components (.tsx): large connected render functions are legitimate —
    // per-function cap 300 (file cap stays 500). .ts logic stays 200.
    files: ['src/**/*.tsx', 'mobile/**/*.tsx'],
    ignores: ['**/*.{test,spec}.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'max-lines-per-function': [
        'error',
        { max: 300, skipBlankLines: false, skipComments: false, IIFEs: true },
      ],
    },
  },
  {
    files: ['**/*.{test,spec}.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
    },
    plugins: {
      'react-hooks': legacyDisableStub(['exhaustive-deps', 'rules-of-hooks']),
      '@typescript-eslint': legacyDisableStub([
        'no-require-imports',
        'consistent-type-imports',
        'only-throw-error',
      ]),
      'jsx-a11y': legacyDisableStub(['no-autofocus']),
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'max-lines': ['error', { max: 2000, skipBlankLines: false, skipComments: false }],
    },
  },
];
