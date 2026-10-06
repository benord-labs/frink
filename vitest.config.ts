import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const setupFiles = ['./vitest.setup.ts'];
const exclude = [
  'node_modules',
  '**/node_modules/**',
  'dist',
  'release',
  '**/*.d.ts',
  '**/*.e2e.test.ts',
];
// Must equal the renderer's babel plugin in electron.vite.config.ts, so compiled tests run the
// compiler that ships. scripts/testing/vitest-projects.test.ts fails when the two differ.
export const reactCompilerBabelPlugin = ['babel-plugin-react-compiler', { target: '19' }];
// Renderer tests that assert render counts or object identity. They run through the React Compiler,
// as the shipped renderer does; every other test runs uncompiled.
const compiledTests = 'src/renderer/**/*.compiled.{test,spec}.{ts,tsx}';

// include, exclude and setupFiles are declared per project: `extends: true` concatenates arrays,
// so a root include would make the compiled project run every test a second time.
export const unitProject = {
  test: {
    name: 'unit',
    setupFiles,
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'relay/**/*.{test,spec}.ts',
      'live-activity-forwarder/tests/**/*.test.ts',
      'scripts/**/*.{test,spec}.{ts,mjs}',
    ],
    exclude: [...exclude, compiledTests],
  },
};

export const compiledProject = {
  plugins: [react({ babel: { plugins: [reactCompilerBabelPlugin] } })],
  test: {
    name: 'compiled',
    setupFiles,
    include: [compiledTests],
    exclude,
  },
};

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['json'],
      reportsDirectory: './coverage',
      thresholds: {
        statements: 65,
        functions: 63,
      },
    },
    // Heavy main-process suites (tRPC, fs hooks) time out under default CPU saturation on dev machines/CI.
    maxWorkers: 2,
    environment: 'node',
    environmentOptions: {
      'src/renderer/**': 'happy-dom',
    },
    // Electron 43 ships NO install lifecycle script; node_modules/electron/index.js ends
    // `module.exports = getElectronPath()`, which downloads the ~120MB binary on first require and
    // throws "Electron failed to install correctly" when that fetch fails. A test process must never
    // reach that: neither vi.mock('electron') nor resolve.alias can prevent it, because a dependency's
    // internal CJS require('electron') (@sentry/electron/main — see vitest.setup.ts) is externalized
    // and resolved by Node. getElectronPath() checks this override BEFORE both download branches
    // (index.js:30), so it is the one seam that covers first-party and dependency routes alike, and it
    // preserves today's semantics exactly: require('electron') still returns a path string.
    // The path is a sentinel and deliberately does not exist — nothing may actually launch Electron here.
    env: {
      ELECTRON_OVERRIDE_DIST_PATH: resolve(__dirname, 'node_modules/.electron-test-sentinel'),
      // Test behavior must not depend on app configuration exported by the parent shell.
      // Suites that exercise a specific value can opt in with vi.stubEnv().
      NODE_ENV: 'test',
      // FRINK_HOME + FRINK_CUSTOM_NODES_DIR: per-file temp home, set in vitest.setup.ts.
    },
    projects: [
      { extends: true, ...unitProject },
      { extends: true, ...compiledProject },
    ],
  },
  esbuild: {
    // @benord-labs/frink-primitives ships source TSX authored with the automatic JSX
    // runtime (no `import React`). frink's own TSX gets automatic via tsconfig, but that
    // doesn't reach node_modules, so the package's components transformed here with the
    // classic runtime throw "React is not defined". Pin automatic for all TSX vitest transforms.
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
    },
  },
});
