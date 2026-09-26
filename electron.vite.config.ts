import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin, loadEnv } from 'electron-vite';

const mode = process.env.MODE ?? process.env.NODE_ENV ?? 'development';
// Side effect: load main/renderer/preload-prefixed values into process.env.
loadEnv(mode);

// Build-time env vars that don't have a MAIN_VITE_/RENDERER_VITE_ prefix
// (SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT) aren't picked up by
// electron-vite's loadEnv — load them ourselves from .env / .env.local.
// Existing process.env values win (CI secrets take precedence over files).
for (const file of ['.env', '.env.local']) {
  try {
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // file may not exist
  }
}

// Sentry source-map upload. Strictly opt-in: requires both SENTRY_AUTH_TOKEN
// and SENTRY_UPLOAD=1. `bun run release` sets SENTRY_UPLOAD=1; daily
// `bun run build` skips the plugin entirely so contributors aren't slowed
// down or blocked by Sentry misconfiguration. The plugin uses
// `build.sourcemap = 'hidden'` (no //# sourceMappingURL= comment in the
// bundle) and deletes generated .map files after upload — so maps reach
// Sentry's servers but never reach the .asar. errorHandler downgrades upload
// failures (bad slug, network) to warnings so a Sentry outage can't break a
// release build.
function sentryPlugins() {
  if (!process.env.SENTRY_AUTH_TOKEN) return [];
  const upload = process.env.SENTRY_UPLOAD;
  if (upload !== '1' && upload !== 'true') return [];
  return [
    sentryVitePlugin({
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      release: { name: process.env.npm_package_version },
      sourcemaps: {
        assets: ['./out/**'],
        filesToDeleteAfterUpload: ['./out/**/*.map'],
      },
      telemetry: false,
      errorHandler: (err) => {
        // biome-ignore lint/suspicious/noConsole: sentry error handler
        console.warn('[sentry] source-map upload failed:', err.message);
      },
    }),
  ];
}

const config = {
  main: {
    plugins: [
      externalizeDepsPlugin({
        // Don't externalize these - bundle them instead
        exclude: ['superjson', 'trpc-electron', 'gray-matter', 'async-mutex', 'zod'],
      }),
      ...sentryPlugins(),
    ],
    build: {
      sourcemap: 'hidden',
      lib: {
        entry: resolve(__dirname, 'src/main/index.ts'),
      },
      rollupOptions: {
        external: [
          'electron',
          '@prisma/client',
          '@anthropic-ai/claude-agent-sdk', // ESM module - must use dynamic import
        ],
        output: {
          format: 'cjs',
          // Bundle the main process into a single file: internal dynamic imports are inlined rather
          // than code-split. Chunkless output is deterministic for a freshly-built checkout — there
          // are no separate chunk files a startup `import()` could out-race. External deps (declared
          // above, incl. the ESM SDK) stay external and unaffected.
          inlineDynamicImports: true,
        },
      },
    },
  },
  preload: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ['trpc-electron'],
      }),
      ...sentryPlugins(),
    ],
    build: {
      sourcemap: 'hidden',
      lib: {
        entry: resolve(__dirname, 'src/preload/index.ts'),
      },
      rollupOptions: {
        external: ['electron'],
        output: {
          format: 'cjs',
        },
      },
    },
  },
  renderer: {
    plugins: [
      react({
        babel: {
          plugins: [['babel-plugin-react-compiler', { target: '19' }]],
        },
      }),
      ...sentryPlugins(),
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/'),
        // Polyfill Node.js 'path' module for browser (needed by monaco-editor-auto-typings)
        path: 'path-browserify',
      },
    },
    build: {
      sourcemap: 'hidden',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
    css: {
      postcss: {
        plugins: [tailwindcss()],
      },
    },
  },
};

export default defineConfig(config as never);
